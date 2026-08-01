import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type {
  ActionId,
  DomainEventId,
  EffectInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import {
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
  type SubUnitState,
} from "../model/applied-effect.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { SubUnitDamageReason } from "../events/domain-event.js";
import { toEffectSnapshot, type EffectSnapshot, type ValueChange } from "../events/state-delta.js";

/**
 * R-SUB-01: サブユニットを保持する`AppliedEffect`だけを付与順のまま返す。
 * `duplicate: true`固定で付与する（`effect-action-group-resolver.ts`）ため
 * R-EFF-05の最強選択は関与せず、残存インスタンスはすべて有効である。耐久力が
 * 0のインスタンスは失効済みとして扱い、除去が完了する前に参照された場合でも
 * 合計・吸収・追加ダメージのいずれにも含めない（`shield-policy.ts`の
 * `shieldInstances`と同じ規約）。
 */
export function subUnitInstances<T extends { readonly subUnit?: SubUnitState }>(
  effects: readonly T[],
): readonly T[] {
  return effects.filter((effect) => effect.subUnit !== undefined && effect.subUnit.durability > 0);
}

/**
 * R-SUB-01第3項「サブユニットの残HPをシールド表示値へ合算できるが、内部状態は
 * 通常シールドと分ける」: 表示用の合計だけを導出する。`shieldPoolsOf`と同じく
 * `AppliedEffect`（Domain）と`EffectSnapshot`（状態スナップショット・StateDelta
 * 共通の外部公開形）の双方から共有できるよう、`subUnit`だけを要求する構造型を
 * 受け取る。実際の消費順・個別状態は`10_API設計.md`「SubUnitStateResponse」が
 * インスタンスごとに公開する（この合計はプールの実体ではない）。
 */
export function subUnitDurabilityTotal(
  effects: readonly { readonly subUnit?: SubUnitState }[],
): number {
  return subUnitInstances(effects).reduce((sum, effect) => sum + effect.subUnit!.durability, 0);
}

/** 1つのサブユニットインスタンスが1回の吸収で失った耐久力。 */
export interface SubUnitDurabilityChange {
  readonly effectInstanceId: EffectInstanceId;
  readonly before: number;
  readonly after: number;
  readonly absorbed: number;
  /** 耐久力が0になった。呼び出し側がR-SUB-01の個別消滅として失効させる。 */
  readonly depleted: boolean;
}

export interface SubUnitAbsorption {
  readonly absorbed: number;
  /** 吸収を反映した`appliedEffects`。吸収が起きなければ入力と同一参照を返す。 */
  readonly appliedEffects: readonly AppliedEffect[];
  /** 実際に耐久力が減ったインスタンスの差分。吸収量が0なら`undefined`。 */
  readonly change?: SubUnitDurabilityChange;
}

/**
 * R-SUB-01第1項「通常シールドをすべて適用した後にサブユニットがダメージを受ける」:
 * 保持者が持つ**先頭の1体**のサブユニットへ`amount`まで吸収させる。R-SHD-02の
 * 適用順のうち#4に当たり、呼び出し側（`damage-application-service.ts`）がタイプ
 * あり・タイプなしシールドを適用し終えた残りをここへ渡す。
 *
 * `absorbFromShieldPool`がプール1つを単位にするのとまったく同じ理由で、この関数は
 * **インスタンス1体**を単位にする — `08_ドメインイベント.md`が要求する「各FACT
 * イベントに対応するPS/Memory候補を直ちに解決する」を満たすため、1体ごとに
 * `減少 → SubUnitDamaged → 連鎖解決 → 枯渇分の失効` を完了してから次の1体へ進む
 * 必要がある。まとめて削ってから通知すると、最初の`SubUnitDamaged`に反応するPSが
 * 「まだ未処理のはずの後続サブユニットとHPまで変更済み」の状態を観測してしまう。
 * 残ダメージがまだあるうちは呼び出し側がこの関数を繰り返し呼ぶ。
 *
 * シールドと違いプール区分（物理/EN/タイプなし）を持たない — R-SUB-01はダメージ
 * タイプによる適用先の分岐を規定せず、代わりに「毒、炎上など、通常シールドで
 * 受けられないダメージはサブユニットでも受けない」だけを定める。その除外は
 * ダメージの発生側（`continuous-damage-service.ts`がBURN/POISONをシールドにも
 * サブユニットにも通さない）が担い、この関数へは到達しない。
 *
 * どのインスタンスから先に減らすかはR-SUB-01が規定しないため、`shield-policy.ts`と
 * 同じ既定（R-EFF-02 #3「優先順が未指定の場合は付与順の古い順」）を採り
 * `appliedEffects`の並びの先頭から使い切る。
 */
export function absorbFromNextSubUnit(target: BattleUnit, amount: number): SubUnitAbsorption {
  if (amount <= 0) {
    return { absorbed: 0, appliedEffects: target.appliedEffects };
  }
  let change: SubUnitDurabilityChange | undefined;
  const appliedEffects = target.appliedEffects.map((effect) => {
    const subUnit = effect.subUnit;
    if (change !== undefined || subUnit === undefined || subUnit.durability <= 0) {
      return effect;
    }
    const taken = Math.min(subUnit.durability, amount);
    const after = subUnit.durability - taken;
    change = {
      effectInstanceId: effect.effectInstanceId,
      before: subUnit.durability,
      after,
      absorbed: taken,
      depleted: after === 0,
    };
    return { ...effect, subUnit: { ...subUnit, durability: after } };
  });

  if (change === undefined) {
    return { absorbed: 0, appliedEffects: target.appliedEffects };
  }
  return { absorbed: change.absorbed, appliedEffects, change };
}

/**
 * R-SUB-02: 所持者の攻撃1回につき、対象ごとに1ヒットずつ追加ダメージを与える
 * サブユニット1体分の解決入力。`AppliedEffect`そのものではなく必要な値だけを
 * 取り出すのは、追加ダメージの解決中に所持者の`appliedEffects`が（追加ダメージ
 * 自身のPS/Memory連鎖で）変化しても、この攻撃で数えるサブユニットの並びを
 * 動かさないためである — 列挙を先に確定させ、各ヒットの実際の値だけをそのつど
 * 最新状態から求める（`shieldDecayPools`と同じ規約）。
 */
export interface SubUnitAdditionalDamageSource {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly additionalDamage: SubUnitState["additionalDamage"];
  /** `SUBUNIT_ADDITIONAL_DAMAGE.providerAttack: SOURCE_SNAPSHOT_ATTACK`が参照する付与時攻撃力。 */
  readonly providerAttack: number;
}

/**
 * R-SUB-02第1項「所持者の攻撃対象ごとに追加ダメージを1ヒット加える」の「1ヒット」を
 * 数える単位を列挙する。所持者が同じサブユニットを複数保持していれば
 * （production例: `SKL_OLGA_VETERAN_PS1`「サブユニット『カムラッドⅡ』を3つ付与する」）
 * その数だけ追加ダメージが発生する。
 *
 * 付与時攻撃力のsnapshotが欠けている場合は0として扱う — 追加ダメージは所持者自身の
 * 攻撃力の項も持つため、snapshot欠落で攻撃全体を例外終了させるより、その項だけを
 * 0にして解決を続ける方が実害が小さい（R-DOT-01の`sourceAttack`と同じ扱い）。
 */
export function subUnitAdditionalDamageSources(
  holder: BattleUnit,
): readonly SubUnitAdditionalDamageSource[] {
  return subUnitInstances(holder.appliedEffects).map((effect) => ({
    effectInstanceId: effect.effectInstanceId,
    effectActionDefinitionId: effect.effectActionDefinitionId,
    additionalDamage: effect.subUnit!.additionalDamage,
    providerAttack: effect.snapshot?.[SUBUNIT_PROVIDER_ATTACK_KEY] ?? 0,
  }));
}

export interface SubUnitDamagedContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/** `reason: DAMAGE_ABSORPTION`のときだけ持つ、この吸収が属するヒットの識別。 */
export interface SubUnitDamagedHitContext {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly hitIndex: number;
}

/**
 * `08_ドメインイベント.md`「SubUnitDamaged」: 耐久力が減った**1インスタンス**につき
 * 1件発行する。呼び出し側は、このイベントを発行した直後にPS/Memoryの即時連鎖を
 * 解決し、枯渇したインスタンスを失効させてから次のインスタンス・次の適用先へ進む
 * （`ShieldConsumed`とまったく同じ順序契約）。
 *
 * `holder`は変化を適用した**後**の状態を渡す（`emitShieldConsumed`と同じ規約）。
 * `before`スナップショットは`subUnit.durability`だけを変化前の値へ差し替えて構築し、
 * `isEffective`は現在の状態から1回だけ導出する — 耐久力の増減はR-EFF-05の採用可否を
 * 変えない（付与は常に`duplicate: true`）。
 */
export function emitSubUnitDamaged(
  context: SubUnitDamagedContext,
  holder: BattleUnit,
  change: SubUnitDurabilityChange,
  reason: SubUnitDamageReason,
  parentEventId: DomainEventId,
  hitContext?: SubUnitDamagedHitContext,
): DomainEventId {
  const effectiveIds = selectEffectiveInstances(holder.appliedEffects);
  const effect = holder.appliedEffects.find(
    (candidate) => candidate.effectInstanceId === change.effectInstanceId,
  )!;
  const afterSnapshot = toEffectSnapshot(effect, effectiveIds.has(change.effectInstanceId));
  const effects: Record<EffectInstanceId, ValueChange<EffectSnapshot | undefined>> = {
    [change.effectInstanceId]: {
      before: { ...afterSnapshot, subUnit: { ...effect.subUnit!, durability: change.before } },
      after: afterSnapshot,
    },
  };
  const damaged = context.recorder.record({
    eventType: "SubUnitDamaged",
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
      effectInstanceId: change.effectInstanceId,
      subUnitDefinitionId: effect.effectActionDefinitionId,
      reason,
      before: change.before,
      after: change.after,
      absorbed: change.absorbed,
    },
    stateDelta: { units: { [holder.battleUnitId]: { effects } } },
  });
  return damaged.eventId;
}
