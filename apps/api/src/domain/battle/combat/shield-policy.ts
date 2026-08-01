import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { truncateFraction } from "../model/resource-gauge.js";
import type { AppliedEffect, ShieldState } from "../model/applied-effect.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { ShieldConsumptionReason } from "../events/domain-event.js";
import { toEffectSnapshot, type EffectSnapshot, type ValueChange } from "../events/state-delta.js";

/**
 * `05_ドメインモデル.md`「ShieldState」/`10_API設計.md`「ShieldStateResponse」:
 * 物理・EN・タイプなしの3プール。R-SHD-01第3項のとおり実体はインスタンス
 * （`AppliedEffect.shield`）側にあり、この型はそこからの導出値である。
 */
export interface ShieldPools {
  readonly physical: number;
  readonly energy: number;
  readonly untyped: number;
}

export const EMPTY_SHIELD_POOLS: ShieldPools = { physical: 0, energy: 0, untyped: 0 };

/** 1つのシールドインスタンスがこのヒットで失った残量。 */
export interface ShieldInstanceChange {
  readonly effectInstanceId: EffectInstanceId;
  readonly shieldType: DamageType | null;
  readonly before: number;
  readonly after: number;
}

export interface ShieldAbsorptionResult {
  /** R-SHD-02 #1: `shieldIgnoreRate`分としてシールドを迂回しHPへ直接向かう量。 */
  readonly hpDirectDamage: number;
  /** R-SHD-02 #2: ダメージタイプに対応するタイプありシールドが吸収した量。 */
  readonly typedShieldAbsorbed: number;
  /** R-SHD-02 #3: タイプなしシールドが吸収した量。 */
  readonly untypedShieldAbsorbed: number;
  /**
   * R-SHD-02 #5: シールドを通り抜けてHPへ向かう量（`hpDirectDamage`を含む）。
   * HPを0未満にしない超過破棄（R-SHD-03第2項）は呼び出し側のHP適用が行う —
   * このサービスは対象のHPを知る必要がない。
   */
  readonly hitPointDamage: number;
  /** 吸収を反映した`appliedEffects`。吸収が起きなければ入力と同一参照を返す。 */
  readonly appliedEffects: readonly AppliedEffect[];
  /** プールごとの変化（`ShieldConsumed`のpayload・stateDeltaの素）。吸収量0のプールは含まない。 */
  readonly changes: readonly ShieldInstanceChange[];
  /** 残量が0になったインスタンス。呼び出し側がR-SHD-01の個別消滅として失効させる。 */
  readonly depletedEffectInstanceIds: readonly EffectInstanceId[];
}

/**
 * R-SHD-01: シールドを保持する`AppliedEffect`だけを付与順のまま返す。
 * `duplicate: true`固定で付与する（`effect-action-group-resolver.ts`）ため
 * R-EFF-05の最強選択（重複なしグループの絞り込み）は関与せず、残存インスタンスは
 * すべて有効である。残量0のインスタンスは失効済みとして扱い、除去が完了する前に
 * 参照された場合でも合計へ含めない。
 */
function shieldInstances<T extends { readonly shield?: ShieldState }>(
  effects: readonly T[],
): readonly T[] {
  return effects.filter((effect) => effect.shield !== undefined && effect.shield.remaining > 0);
}

/**
 * R-SHD-01「同じタイプのシールド付与値を加算する」: 有効なインスタンスからプール
 * 合計を導く。`AppliedEffect`（Domain）と`EffectSnapshot`（状態スナップショット・
 * StateDelta共通の外部公開形）の双方から同じ導出を共有できるよう、`shield`だけを
 * 要求する構造型を受け取る — `10_API設計.md`「ShieldStateResponse」を組み立てる
 * Response Mapperは`BattleUnit`ではなくスナップショットを持つため。
 */
export function shieldPoolsOf(effects: readonly { readonly shield?: ShieldState }[]): ShieldPools {
  let physical = 0;
  let energy = 0;
  let untyped = 0;
  for (const effect of shieldInstances(effects)) {
    const shield = effect.shield!;
    if (shield.shieldType === "PHYSICAL") {
      physical += shield.remaining;
    } else if (shield.shieldType === "EN") {
      energy += shield.remaining;
    } else {
      untyped += shield.remaining;
    }
  }
  return { physical, energy, untyped };
}

/**
 * 1つのプール（`matches`が選ぶインスタンス群）から`amount`まで吸収する。
 *
 * R-SHD-01/R-SHD-02はプール内のどのインスタンスから先に減らすかを規定しない。
 * R-EFF-02 #3「優先順が未指定の場合は付与順の古い順」と同じ既定を採り、
 * `appliedEffects`の並び（＝付与順）の先頭から使い切る — 個別消滅条件を持つ
 * インスタンスの失効順を、Setの反復順のような不安定な基準に委ねないため。
 */
function drainPool(
  effects: readonly AppliedEffect[],
  matches: (effect: AppliedEffect) => boolean,
  amount: number,
  changes: ShieldInstanceChange[],
  depleted: EffectInstanceId[],
): { readonly effects: readonly AppliedEffect[]; readonly absorbed: number } {
  if (amount <= 0) {
    return { effects, absorbed: 0 };
  }
  let remainingDamage = amount;
  let absorbed = 0;
  const next = effects.map((effect) => {
    const shield = effect.shield;
    if (remainingDamage <= 0 || shield === undefined || shield.remaining <= 0 || !matches(effect)) {
      return effect;
    }
    const taken = Math.min(shield.remaining, remainingDamage);
    remainingDamage -= taken;
    absorbed += taken;
    const after = shield.remaining - taken;
    changes.push({
      effectInstanceId: effect.effectInstanceId,
      shieldType: shield.shieldType,
      before: shield.remaining,
      after,
    });
    if (after === 0) {
      depleted.push(effect.effectInstanceId);
    }
    return { ...effect, shield: { ...shield, remaining: after } };
  });
  return absorbed === 0 ? { effects, absorbed: 0 } : { effects: next, absorbed };
}

/**
 * R-SHD-02/R-SHD-03: 確定した1ヒットのダメージを適用先へ順に振り分ける。
 *
 * 1. `shieldIgnoreRate`分をHPへ直接向ける（`hpDirectDamage`）
 * 2. 残りを`damageType`に対応するタイプありシールドへ適用する
 * 3. さらに残った分をタイプなしシールドへ適用する
 * 4. （サブユニット＝R-SUB-01はDMG-005のスコープ。現状は素通りする）
 * 5. さらに残った分をHPへ向ける
 *
 * 「対応しないタイプありシールドへダメージを適用しない」（R-SHD-02末尾）ため、
 * 別タイプのタイプありシールドは残量を持っていても素通しになる。
 *
 * `finalDamage`はR-DMG-02/R-NUM-02で既に切り捨て済みの非負整数、シールド残量も
 * R-NUM-02「シールド付与量は適用直前に小数部分を切り捨てる」により非負整数で
 * あるため、この振り分けは整数演算だけで閉じる。唯一の分割である
 * `shieldIgnoreRate`按分だけはR-NUM-02の一般規約どおり切り捨て、端数はシールド側
 * （後段）へ残す — これにより
 * `typedShieldAbsorbed + untypedShieldAbsorbed + hitPointDamage`は常に
 * `finalDamage`と厳密に一致する（`08_ドメインイベント.md`の不変条件#6
 * 「シールド吸収とHPダメージの合計が計算ダメージと一致する」）。`hpDirectDamage`は
 * `hitPointDamage`の内訳（そのうちシールドを迂回した分）であり、独立した適用先では
 * ないため、この合計には別項として現れない。
 */
export function absorbWithShields(
  target: BattleUnit,
  finalDamage: number,
  damageType: DamageType,
  shieldIgnoreRate: number,
): ShieldAbsorptionResult {
  const hpDirectDamage = truncateFraction(finalDamage * shieldIgnoreRate);
  const changes: ShieldInstanceChange[] = [];
  const depleted: EffectInstanceId[] = [];

  const typed = drainPool(
    target.appliedEffects,
    (effect) => effect.shield!.shieldType === damageType,
    finalDamage - hpDirectDamage,
    changes,
    depleted,
  );
  const untyped = drainPool(
    typed.effects,
    (effect) => effect.shield!.shieldType === null,
    finalDamage - hpDirectDamage - typed.absorbed,
    changes,
    depleted,
  );

  return {
    hpDirectDamage,
    typedShieldAbsorbed: typed.absorbed,
    untypedShieldAbsorbed: untyped.absorbed,
    hitPointDamage: finalDamage - typed.absorbed - untyped.absorbed,
    appliedEffects: untyped.effects,
    changes,
    depletedEffectInstanceIds: depleted,
  };
}

export interface ShieldConsumedContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/** `reason: DAMAGE_ABSORPTION`のときだけ持つ、この吸収が属するヒットの識別。 */
export interface ShieldConsumedHitContext {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hitIndex: number;
}

/**
 * `08_ドメインイベント.md`「ダメージイベント」ShieldConsumed: `absorbWithShields`
 * （または漸減）が返した`changes`をプール単位（R-SHD-01の「同じタイプのシールド値を
 * 加算する」単位）へまとめ、減少したプールごとに1件発行する。プールの並びは
 * `changes`の並び、すなわちR-SHD-02の適用順（タイプあり→タイプなし）のままにする。
 *
 * `holder`は変化を適用した**後**の状態を渡す（`emitEffectDurationReducedEvents`と
 * 同じ規約）。`before`スナップショットは`shield.remaining`だけを変化前の値へ
 * 差し替えて構築し、`isEffective`は現在の状態から1回だけ導出する — シールド残量の
 * 増減はR-EFF-05の採用可否を変えない（付与は常に`duplicate: true`）。
 *
 * `changes`が空の場合は何も発行せず`parentEventId`をそのまま返す。
 */
export function emitShieldConsumedEvents(
  context: ShieldConsumedContext,
  holder: BattleUnit,
  changes: readonly ShieldInstanceChange[],
  reason: ShieldConsumptionReason,
  parentEventId: DomainEventId,
  hitContext?: ShieldConsumedHitContext,
): DomainEventId {
  if (changes.length === 0) {
    return parentEventId;
  }
  const effectiveIds = selectEffectiveInstances(holder.appliedEffects);
  const pools: { shieldType: DamageType | null; changes: ShieldInstanceChange[] }[] = [];
  for (const change of changes) {
    const pool = pools.find((entry) => entry.shieldType === change.shieldType);
    if (pool === undefined) {
      pools.push({ shieldType: change.shieldType, changes: [change] });
    } else {
      pool.changes.push(change);
    }
  }

  let lastEventId = parentEventId;
  for (const pool of pools) {
    const before = pool.changes.reduce((sum, change) => sum + change.before, 0);
    const after = pool.changes.reduce((sum, change) => sum + change.after, 0);
    const effects: Record<EffectInstanceId, ValueChange<EffectSnapshot | undefined>> = {};
    for (const change of pool.changes) {
      // 変化後のインスタンスは、枯渇（`after === 0`）でこの直後に失効させる場合でも
      // まだ`holder.appliedEffects`に残っている（除去は`EffectExpired`が行う）。
      const effect = holder.appliedEffects.find(
        (candidate) => candidate.effectInstanceId === change.effectInstanceId,
      )!;
      const afterSnapshot = toEffectSnapshot(effect, effectiveIds.has(change.effectInstanceId));
      effects[change.effectInstanceId] = {
        before: { ...afterSnapshot, shield: { ...effect.shield!, remaining: change.before } },
        after: afterSnapshot,
      };
    }
    const consumed = context.recorder.record({
      eventType: "ShieldConsumed",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: holder.battleUnitId,
      targetUnitIds: [holder.battleUnitId],
      payload: {
        ...(hitContext !== undefined
          ? {
              effectActionDefinitionId: hitContext.effectActionDefinitionId,
              hitIndex: hitContext.hitIndex,
            }
          : {}),
        battleUnitId: holder.battleUnitId,
        reason,
        shieldType: pool.shieldType,
        before,
        after,
        absorbed: before - after,
      },
      stateDelta: { units: { [holder.battleUnitId]: { effects } } },
    });
    lastEventId = consumed.eventId;
  }
  return lastEventId;
}

/** `BattleUnitId`をキーに`units`から1体引く（`shield-policy.ts`内の共通ヘルパー）。 */
export function shieldHolderOf(
  units: readonly BattleUnit[],
  battleUnitId: BattleUnitId,
): BattleUnit | undefined {
  return units.find((unit) => unit.battleUnitId === battleUnitId);
}

/**
 * `ShieldDecayDefinition.owner`を具体的なユニットIDへ解決する（`applied-effect-
 * duration.ts`の`resolveTimeLimitOwnerUnitId`と同じ規約・同じ既定`EFFECT_TARGET`）。
 * 漸減の契機はR-EFF-04の行動単位期間と同じCOMPLETINGタイミングを共有するため、
 * 「誰の行動で減らすか」の解決規則も共有する。
 */
function resolveDecayOwnerUnitId(effect: AppliedEffect): BattleUnitId | "BATTLE" {
  const owner = effect.shield?.decay?.owner ?? "EFFECT_TARGET";
  if (owner === "BATTLE") {
    return "BATTLE";
  }
  return owner === "EFFECT_SOURCE" ? (effect.sourceId ?? "BATTLE") : effect.targetId;
}

/**
 * 漸減は保持者ごとに独立して起きうる（`decay.owner`が`BATTLE`/`EFFECT_SOURCE`の
 * 場合、行動者以外のユニットが保持するシールドも同じ契機で減る）ため、吸収の
 * `ShieldInstanceChange`と違って保持者IDを持つ。
 */
export type ShieldDecayChange = ShieldInstanceChange & { readonly battleUnitId: BattleUnitId };

export interface ShieldDecayResult {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly ShieldDecayChange[];
  readonly depleted: readonly {
    readonly battleUnitId: BattleUnitId;
    readonly effectInstanceId: EffectInstanceId;
  }[];
}

/**
 * `SHIELD_DECAY_OVER_TIME`（DMG-004、Issue #194、R-SHD-01）: `actingUnitId`が1つの
 * 行動を完了したときに呼ぶ。`decay.owner`が解決するユニットが`actingUnitId`と一致する
 * （`BATTLE`はどのユニットの行動でも一致する）シールドインスタンスの残量を
 * `切り捨て(付与時最大値 × decay.ratio)`だけ減らす。raw原文の例は
 * `SKL_SHIRANA_LUCKY_EX`「シールドは1行動に付き最大値の25%減少する」。
 *
 * 減少量の基準を**付与時最大値**（`magnitude`）に置くのは原文が「最大値の25%」と
 * 明示しているためで、残量に対する等比減衰ではない（4行動でちょうど枯渇する）。
 * R-NUM-02の一般規約どおり切り捨てるが、`ratio > 0`なら最低1は減らす — 切り捨てで
 * 0になると漸減が永久に進まず、`decay`の宣言が無意味になるため。
 *
 * `decrementActionEffectDurations`と同じく、0になったインスタンスをこの関数自身は
 * 除去しない（`EffectExpired`発行・除去・カスケードは呼び出し側の責務）。
 * 付与された当該行動を除外する`grantedActionId`相当の扱いは持たない — 漸減は
 * R-EFF-04の残り回数ではなく効果量そのものの変化であり、R-EFF-04 #2の「付与された
 * 当該行動では減らさない」規則はシールド量には及ばないためである。
 */
export function decayActionShields(
  units: readonly BattleUnit[],
  actingUnitId: BattleUnitId,
): ShieldDecayResult {
  const changes: ShieldDecayChange[] = [];
  const depleted: { battleUnitId: BattleUnitId; effectInstanceId: EffectInstanceId }[] = [];
  const nextUnits = units.map((unit) => {
    let changedInUnit = false;
    const nextEffects = unit.appliedEffects.map((effect) => {
      const shield = effect.shield;
      if (shield?.decay === undefined || shield.remaining <= 0) {
        return effect;
      }
      const owner = resolveDecayOwnerUnitId(effect);
      if (owner !== "BATTLE" && owner !== actingUnitId) {
        return effect;
      }
      const step = Math.max(1, truncateFraction(effect.magnitude * shield.decay.ratio));
      const after = Math.max(0, shield.remaining - step);
      changes.push({
        battleUnitId: unit.battleUnitId,
        effectInstanceId: effect.effectInstanceId,
        shieldType: shield.shieldType,
        before: shield.remaining,
        after,
      });
      if (after === 0) {
        depleted.push({
          battleUnitId: unit.battleUnitId,
          effectInstanceId: effect.effectInstanceId,
        });
      }
      changedInUnit = true;
      return { ...effect, shield: { ...shield, remaining: after } };
    });
    return changedInUnit ? { ...unit, appliedEffects: nextEffects } : unit;
  });
  return { units: nextUnits, changes, depleted };
}
