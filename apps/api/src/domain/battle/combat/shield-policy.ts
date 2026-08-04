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

/** 1つのシールドインスタンスが1回の減少（吸収または漸減）で失った残量。 */
export interface ShieldInstanceChange {
  readonly effectInstanceId: EffectInstanceId;
  readonly before: number;
  readonly after: number;
}

/**
 * `08_ドメインイベント.md`「ShieldConsumed payload」が要求する**プール単位**の変化。
 *
 * `poolBefore`/`poolAfter`は、この減少で変化しなかった同タイプのインスタンスも
 * 含めたプール合計である（R-SHD-01「同じタイプのシールド付与値を加算する」）。
 * 変化したインスタンスの合計だけを載せると、同タイプのシールドが `10 + 50` あり
 * 5だけ吸収した場合に `before: 10 / after: 5` という「プールの前後値」ではない
 * 値を公開してしまう。
 */
export interface ShieldPoolChange {
  readonly battleUnitId: BattleUnitId;
  /** `null`はタイプなしシールドプール。 */
  readonly shieldType: DamageType | null;
  readonly poolBefore: number;
  readonly poolAfter: number;
  readonly absorbed: number;
  readonly instances: readonly ShieldInstanceChange[];
  /** 残量が0になったインスタンス。呼び出し側がR-SHD-01の個別消滅として失効させる。 */
  readonly depletedEffectInstanceIds: readonly EffectInstanceId[];
}

export interface ShieldPoolAbsorption {
  readonly absorbed: number;
  /** 吸収を反映した`appliedEffects`。吸収が起きなければ入力と同一参照を返す。 */
  readonly appliedEffects: readonly AppliedEffect[];
  /** 吸収量が0（＝プールが空、または残ダメージが0）なら`undefined`。 */
  readonly change?: ShieldPoolChange;
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

/** `shieldType`が選ぶプール（`null`はタイプなし）の合計残量。 */
function poolTotalOf(
  effects: readonly { readonly shield?: ShieldState }[],
  shieldType: DamageType | null,
): number {
  return shieldInstances(effects)
    .filter((effect) => effect.shield!.shieldType === shieldType)
    .reduce((sum, effect) => sum + effect.shield!.remaining, 0);
}

/**
 * R-SHD-02: `shieldType`が選ぶ**1つのプール**から`amount`まで吸収する。
 *
 * R-SHD-02の適用順（`shieldIgnoreRate`分→タイプあり→タイプなし→HP）そのものは
 * 呼び出し側（`damage-application-service.ts`）が順に駆動する。プール1つを単位に
 * したのは、`08_ドメインイベント.md`が要求する「各FACTイベントに対応するPS/Memory
 * 候補を直ちに解決する」を満たすため — プールごとに `減少 → ShieldConsumed →
 * 連鎖解決 → 枯渇分の失効` を完了してから次のプールへ進む必要がある。
 * まとめて吸収してから通知すると、タイプありプールの
 * `ShieldConsumed`に反応するPSが、まだ未処理のはずのタイプなしプールとHPまで
 * 変更済みの状態を観測してしまう。
 *
 * R-SHD-01/R-SHD-02はプール内のどのインスタンスから先に減らすかを規定しない。
 * R-EFF-02 #3「優先順が未指定の場合は付与順の古い順」と同じ既定を採り、
 * `appliedEffects`の並び（＝付与順）の先頭から使い切る — 個別消滅条件を持つ
 * インスタンスの失効順を、Setの反復順のような不安定な基準に委ねないため。
 *
 * 「対応しないタイプありシールドへダメージを適用しない」（R-SHD-02末尾）は、
 * 呼び出し側がヒットの`damageType`と一致するプールしか選ばないことで満たす。
 */
export function absorbFromShieldPool(
  target: BattleUnit,
  amount: number,
  shieldType: DamageType | null,
): ShieldPoolAbsorption {
  if (amount <= 0) {
    return { absorbed: 0, appliedEffects: target.appliedEffects };
  }
  const poolBefore = poolTotalOf(target.appliedEffects, shieldType);
  if (poolBefore <= 0) {
    return { absorbed: 0, appliedEffects: target.appliedEffects };
  }
  const instances: ShieldInstanceChange[] = [];
  const depleted: EffectInstanceId[] = [];
  let remainingDamage = amount;
  let absorbed = 0;
  const appliedEffects = target.appliedEffects.map((effect) => {
    const shield = effect.shield;
    if (
      remainingDamage <= 0 ||
      shield === undefined ||
      shield.remaining <= 0 ||
      shield.shieldType !== shieldType
    ) {
      return effect;
    }
    const taken = Math.min(shield.remaining, remainingDamage);
    remainingDamage -= taken;
    absorbed += taken;
    const after = shield.remaining - taken;
    instances.push({ effectInstanceId: effect.effectInstanceId, before: shield.remaining, after });
    if (after === 0) {
      depleted.push(effect.effectInstanceId);
    }
    return { ...effect, shield: { ...shield, remaining: after } };
  });

  return {
    absorbed,
    appliedEffects,
    change: {
      battleUnitId: target.battleUnitId,
      shieldType,
      poolBefore,
      poolAfter: poolBefore - absorbed,
      absorbed,
      instances,
      depletedEffectInstanceIds: depleted,
    },
  };
}

/**
 * R-SHD-02 #1: `shieldIgnoreRate`分としてシールドを迂回しHPへ直接向かう量。
 *
 * R-NUM-02の一般規約どおり切り捨て、端数はシールド側（後段）へ残す。これにより
 * `typedShieldAbsorbed + untypedShieldAbsorbed + hitPointDamage + discardedDamage`
 * は常に`calculatedDamage`と厳密に一致する（`08_ドメインイベント.md`の不変条件#6）。
 * 戻り値は`hitPointDamage`の内訳（そのうちシールドを迂回した分）であり、独立した
 * 適用先ではないためこの合計には別項として現れない。
 */
export function shieldBypassedDamage(finalDamage: number, shieldIgnoreRate: number): number {
  return truncateFraction(finalDamage * shieldIgnoreRate);
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
 * `08_ドメインイベント.md`「ShieldConsumed payload」: 減少した**1プール**につき
 * 1件発行する。呼び出し側は、このイベントを発行した直後にPS/Memoryの即時連鎖を
 * 解決し、枯渇したインスタンスを失効させてから次のプール・次の適用先へ進む。
 *
 * `holder`は変化を適用した**後**の状態を渡す（`emitEffectDurationReducedEvents`と
 * 同じ規約）。`before`スナップショットは`shield.remaining`だけを変化前の値へ
 * 差し替えて構築し、`isEffective`は現在の状態から1回だけ導出する — シールド残量の
 * 増減はR-EFF-05の採用可否を変えない（付与は常に`duplicate: true`）。
 */
export function emitShieldConsumed(
  context: ShieldConsumedContext,
  holder: BattleUnit,
  change: ShieldPoolChange,
  reason: ShieldConsumptionReason,
  parentEventId: DomainEventId,
  hitContext?: ShieldConsumedHitContext,
): DomainEventId {
  const effectiveIds = selectEffectiveInstances(holder.appliedEffects);
  const effects: Record<EffectInstanceId, ValueChange<EffectSnapshot | undefined>> = {};
  for (const instance of change.instances) {
    // 変化後のインスタンスは、枯渇（`after === 0`）でこの直後に失効させる場合でも
    // まだ`holder.appliedEffects`に残っている（除去は`EffectExpired`が行う）。
    const effect = holder.appliedEffects.find(
      (candidate) => candidate.effectInstanceId === instance.effectInstanceId,
    )!;
    const afterSnapshot = toEffectSnapshot(effect, effectiveIds.has(instance.effectInstanceId));
    effects[instance.effectInstanceId] = {
      before: { ...afterSnapshot, shield: { ...effect.shield!, remaining: instance.before } },
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
    parentEventId,
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
      shieldType: change.shieldType,
      before: change.poolBefore,
      after: change.poolAfter,
      absorbed: change.absorbed,
    },
    stateDelta: { units: { [holder.battleUnitId]: { effects } } },
  });
  return consumed.eventId;
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

export interface ShieldDecayResult {
  readonly units: readonly BattleUnit[];
  /** 変化したプールの差分。漸減対象が無ければ`undefined`。 */
  readonly change?: ShieldPoolChange;
}

/**
 * `SHIELD_DECAY_OVER_TIME`（DMG-004、Issue #194、R-SHD-01）: `actingUnitId`が1つの
 * 行動を完了したとき、`holderUnitId`が保持する`shieldType`プールの漸減を解決する。
 * `decay.owner`が解決するユニットが`actingUnitId`と一致する（`BATTLE`はどの
 * ユニットの行動でも一致する）インスタンスの残量を
 * `切り捨て(付与時最大値 × decay.ratio)`だけ減らす。raw原文の例は
 * `SKL_SHIRANA_LUCKY_EX`「シールドは1行動に付き最大値の25%減少する」。
 *
 * 減少量の基準を**付与時最大値**（`magnitude`）に置くのは原文が「最大値の25%」と
 * 明示しているためで、残量に対する等比減衰ではない（4行動でちょうど枯渇する）。
 * R-NUM-02の一般規約どおり切り捨てるが、`ratio > 0`なら最低1は減らす — 切り捨てで
 * 0になると漸減が永久に進まず、`decay`の宣言が無意味になるため。
 *
 * 保持者ではなく**保持者×プール**を1回の単位にする。
 * 保持者の全プールをまとめて減らしてから順にイベントを発行すると、最初の
 * `ShieldConsumed`の時点で後続プールも既に漸減済みになり、`08_ドメインイベント.md`
 * の「保持者→プールの単位で、減少→通知→失効を完了してから次へ進む」契約を
 * 満たせない。加えて、最初のイベントのPS/Memory連鎖が後続プールの効果を解除すると
 * 事前に集めた差分が古くなり、`emitShieldConsumed`が存在しないインスタンスを
 * 参照して失敗し得る。呼び出し側は`shieldDecayPools`で得た並びに沿って、
 * そのつど最新の`units`からこの関数を呼び直す。
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
  holderUnitId: BattleUnitId,
  shieldType: DamageType | null,
): ShieldDecayResult {
  const holder = units.find((unit) => unit.battleUnitId === holderUnitId);
  if (holder === undefined) {
    return { units };
  }
  // プール合計（`ShieldConsumed.before`）は、漸減しないインスタンスも含めた
  // 変化前の総量である。
  const poolBefore = poolTotalOf(holder.appliedEffects, shieldType);
  const instances: ShieldInstanceChange[] = [];
  const depleted: EffectInstanceId[] = [];
  let absorbed = 0;
  const nextEffects = holder.appliedEffects.map((effect) => {
    const shield = effect.shield;
    if (shield?.decay === undefined || shield.remaining <= 0 || shield.shieldType !== shieldType) {
      return effect;
    }
    const owner = resolveDecayOwnerUnitId(effect);
    if (owner !== "BATTLE" && owner !== actingUnitId) {
      return effect;
    }
    const step = Math.max(1, truncateFraction(effect.magnitude * shield.decay.ratio));
    const after = Math.max(0, shield.remaining - step);
    instances.push({ effectInstanceId: effect.effectInstanceId, before: shield.remaining, after });
    absorbed += shield.remaining - after;
    if (after === 0) {
      depleted.push(effect.effectInstanceId);
    }
    return { ...effect, shield: { ...shield, remaining: after } };
  });

  if (instances.length === 0) {
    return { units };
  }
  return {
    units: units.map((unit) =>
      unit.battleUnitId === holderUnitId ? { ...unit, appliedEffects: nextEffects } : unit,
    ),
    change: {
      battleUnitId: holderUnitId,
      shieldType,
      poolBefore,
      poolAfter: poolBefore - absorbed,
      absorbed,
      instances,
      depletedEffectInstanceIds: depleted,
    },
  };
}

/**
 * `decayActionShields`の対象になる保持者を`units`の並び（決定的）で列挙する。
 * `decay.owner`が`BATTLE`/`EFFECT_SOURCE`の場合、行動者以外のユニットが保持する
 * シールドも同じ完了契機で減るため、呼び出し側は全ユニットを走査する必要がある。
 */
export function shieldDecayHolders(
  units: readonly BattleUnit[],
  actingUnitId: BattleUnitId,
): readonly BattleUnitId[] {
  return units
    .filter((unit) => decayablePoolsOf(unit, actingUnitId).length > 0)
    .map((unit) => unit.battleUnitId);
}

/**
 * `holderUnitId`が持つ漸減対象プールを、R-SHD-02の適用順と同じ並び
 * （タイプあり→タイプなし）で列挙する。呼び出し側はこの並びを**先に確定させて**
 * から1プールずつ解決する — 解決中のPS/Memory連鎖が新しいシールドを付与しても、
 * 同じ行動完了で連鎖的に漸減が増えないようにするため（列挙は固定、各プールの
 * 実際の減少量だけがそのつど最新状態から決まる）。
 */
export function shieldDecayPools(
  units: readonly BattleUnit[],
  actingUnitId: BattleUnitId,
  holderUnitId: BattleUnitId,
): readonly (DamageType | null)[] {
  const holder = units.find((unit) => unit.battleUnitId === holderUnitId);
  return holder === undefined ? [] : decayablePoolsOf(holder, actingUnitId);
}

function decayablePoolsOf(
  holder: BattleUnit,
  actingUnitId: BattleUnitId,
): readonly (DamageType | null)[] {
  const pools: (DamageType | null)[] = [];
  for (const effect of holder.appliedEffects) {
    const shield = effect.shield;
    if (shield?.decay === undefined || shield.remaining <= 0) {
      continue;
    }
    const owner = resolveDecayOwnerUnitId(effect);
    if (owner !== "BATTLE" && owner !== actingUnitId) {
      continue;
    }
    if (!pools.includes(shield.shieldType)) {
      pools.push(shield.shieldType);
    }
  }
  return pools.sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
}
