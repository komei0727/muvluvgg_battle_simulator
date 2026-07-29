import {
  buildInitialDurationState,
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
  type EffectImmunityState,
  type HealingLinkState,
  type StatusEffectDetails,
} from "../model/applied-effect.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { selectEffectiveInstances } from "../model/effective-effect-selector.js";
import { toEffectSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { StatusKind } from "../../catalog/definitions/effect-action-payload.js";
import type { Side } from "../../shared/side.js";
import { effectCategoriesOf } from "./effect-category-classifier.js";

export interface GrantEffectContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface GrantEffectRequest {
  /**
   * 付与する効果の`EffectActionDefinition`そのもの。M7-011（Issue #265、
   * `EFFECT_APPLIED_CLASSIFICATION_PAYLOAD`）以前は定義IDだけを受け取っていたが、
   * `EffectApplied`の分類payload（`effectKind`/`categories`）は定義の`kind`と
   * `effect-category-classifier.ts`から導く必要があり、IDと定義が食い違う余地を
   * 残さないよう定義自体を正本にした（`effectActionDefinitionId`はここから導く）。
   */
  readonly definition: EffectActionDefinition;
  /**
   * 付与者。R-MEM-04（Issue #179）: Memory の `triggeredEffects` 由来の付与だけは
   * 具体的な付与者ユニットを持たないため`undefined`を渡し、代わりに`sourceSide`
   * を渡す（`AppliedEffect.sourceId`/`EffectApplied`も同じ規約）。
   */
  readonly sourceId?: BattleUnitId;
  /** R-MEM-04: Memory由来の付与だけが持つ、付与元の陣営。 */
  readonly sourceSide?: Side;
  readonly targetId: BattleUnitId;
  readonly duplicate: boolean;
  readonly magnitude: number;
  /** TGT-004フェーズ3（Issue #167、R-ACTN-03）: `APPLY_STATUS`由来の付与だけが持つ。 */
  readonly statusKind?: StatusKind;
  /** M7-004（Issue #183）: `statusKind`がEVASION/BLIND/FREEZE/DAMAGE_IMMUNITYの場合だけ持つ。 */
  readonly statusDetails?: StatusEffectDetails;
  /** M7-001B（Issue #243、R-EFF-03）: `EFFECT_IMMUNITY`由来の付与だけが持つ。 */
  readonly immunity?: EffectImmunityState;
  /** M7-004（ON_ATTACK_BONUS_DAMAGE_BUFF、Issue #183）: `APPLY_ATTACK_DAMAGE_BONUS`由来の付与だけが持つ。 */
  readonly isAttackDamageBonus?: true;
  /** M7-005-HEAL-LINK（Issue #229、R-HEAL-04）: `APPLY_HEALING_LINK`由来の付与だけが持つ。 */
  readonly healingLink?: HealingLinkState;
  readonly durationDefinition: DurationDefinition;
  readonly snapshot?: Readonly<Record<string, number>>;
}

export interface GrantEffectResult {
  readonly units: readonly BattleUnit[];
  readonly appliedEffect: AppliedEffect;
  readonly lastEventId: DomainEventId;
}

/**
 * R-EFF-01: 新しい`AppliedEffect`インスタンスを対象へ個別に付与し、`EffectApplied`
 * を発行する。同種の既存効果を上書き・統合せず、重複あり・重複なしのどちらも
 * 常に新規インスタンスとして追加する（重複なし効果群の最強選択・次点繰上げは
 * EFF-002のスコープであり、この関数は関与しない）。
 */
export function grantEffect(
  context: GrantEffectContext,
  units: readonly BattleUnit[],
  request: GrantEffectRequest,
  parentEventId: DomainEventId,
): GrantEffectResult {
  const target = requireUnit(units, request.targetId);
  const effectActionDefinitionId = request.definition.effectActionDefinitionId;
  const kindKey = effectKindKeyFromDefinitionId(effectActionDefinitionId);
  const timeLimit = request.durationDefinition.timeLimit;

  const newEffect: AppliedEffect = {
    effectInstanceId: context.recorder.nextEffectInstanceId(),
    effectActionDefinitionId,
    kindKey,
    duplicate: request.duplicate,
    ...(request.sourceId !== undefined ? { sourceId: request.sourceId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    targetId: request.targetId,
    magnitude: request.magnitude,
    ...(request.statusKind !== undefined ? { statusKind: request.statusKind } : {}),
    ...(request.statusDetails !== undefined ? { statusDetails: request.statusDetails } : {}),
    ...(request.immunity !== undefined ? { immunity: request.immunity } : {}),
    ...(request.isAttackDamageBonus !== undefined
      ? { isAttackDamageBonus: request.isAttackDamageBonus }
      : {}),
    ...(request.healingLink !== undefined ? { healingLink: request.healingLink } : {}),
    duration: buildInitialDurationState(request.durationDefinition, {
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      turnNumber: context.turnNumber,
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    }),
    appliedTurnNumber: context.turnNumber,
    ...(context.actionId !== undefined ? { appliedActionId: context.actionId } : {}),
    ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}),
  };

  // R-EFF-05: この新規インスタンス自身が採用対象かどうかは、対象の既存効果を
  // 含めた選択結果から決まる（重複あり効果は常にtrue、重複なし効果は同種
  // グループ内で最強の場合だけtrue）。この付与によって他の既存インスタンスの
  // 採用可否が変化した場合の`EffectiveEffectChanged`は、呼び出し側のCombatStat
  // 再計算（`combat-stat-recalculation-service.ts`）が扱う — ここでは新規
  // インスタンス自身の`EffectApplied.stateDelta`だけを正しく組み立てる。
  const isEffective = selectEffectiveInstances([...target.appliedEffects, newEffect]).has(
    newEffect.effectInstanceId,
  );

  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetId
      ? { ...unit, appliedEffects: [...unit.appliedEffects, newEffect] }
      : unit,
  );

  const applied = context.recorder.record({
    eventType: "EffectApplied",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    // `08_ドメインイベント.md`「Memoryイベントは`sourceUnitId`を持たず、
    // `sourceSide`を持つ」: Memory由来の付与（R-MEM-04）は発生源ユニットを
    // 持たないため、envelopeもpayloadも`sourceSide`へ置き換える。
    ...(request.sourceId !== undefined ? { sourceUnitId: request.sourceId } : {}),
    ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
    targetUnitIds: [request.targetId],
    payload: {
      effectInstanceId: newEffect.effectInstanceId,
      effectActionDefinitionId,
      ...(request.sourceId !== undefined ? { sourceUnitId: request.sourceId } : {}),
      ...(request.sourceSide !== undefined ? { sourceSide: request.sourceSide } : {}),
      targetUnitId: request.targetId,
      duplicate: request.duplicate,
      kindKey,
      // M7-011（Issue #265、`EFFECT_APPLIED_CLASSIFICATION_PAYLOAD`）:
      // `TriggerDefinition.condition`の`EVENT_PAYLOAD`が「デバフが付与された際」
      // 「状態異常が付与された際」を表現できるようにする分類フィールド。
      // `kindKey`は`EffectActionDefinitionId`そのもの（定義ごとに一意）で分類には
      // 使えないため、効果の種類（`effectKind`）と、解除・免疫判定の正本である
      // `effect-category-classifier.ts`が導く分類集合（`categories`）を併せて運ぶ。
      // `categories`は複数値（R-STS-01「状態異常はデバフの一種」の`APPLY_STATUS`は
      // `STATUS`と`DEBUFF`の両方）を取るため配列とし、`op: CONTAINS`で判定する。
      // 順序はイベント列の決定性のためソートして固定する。
      effectKind: request.definition.kind,
      categories: [...effectCategoriesOf(newEffect, request.definition)].sort(),
      magnitude: request.magnitude,
      ...(request.statusKind !== undefined ? { statusKind: request.statusKind } : {}),
      linkedEffectGroupId: request.durationDefinition.linkedEffectGroupId,
      ...(timeLimit !== undefined
        ? { durationUnit: timeLimit.unit, initialRemaining: timeLimit.count }
        : {}),
      ...(newEffect.duration.timeLimitRemaining !== undefined
        ? { remainingCount: newEffect.duration.timeLimitRemaining }
        : {}),
      ...(timeLimit?.owner !== undefined ? { durationOwner: timeLimit.owner } : {}),
      ...(request.durationDefinition.consumption !== undefined
        ? {
            consumptionKind: request.durationDefinition.consumption.kind,
            consumptionMaxCount: request.durationDefinition.consumption.maxCount,
          }
        : {}),
      ...(newEffect.duration.consumptionRemaining !== undefined
        ? { consumptionRemaining: newEffect.duration.consumptionRemaining }
        : {}),
      ...(request.durationDefinition.expiration !== undefined
        ? { expirationConditions: request.durationDefinition.expiration.conditions }
        : {}),
      ...(newEffect.duration.grantedActionId !== undefined
        ? { grantedActionId: newEffect.duration.grantedActionId }
        : {}),
      ...(newEffect.duration.grantedTurnNumber !== undefined
        ? { grantedTurnNumber: newEffect.duration.grantedTurnNumber }
        : {}),
      ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}),
    },
    stateDelta: {
      units: {
        [request.targetId]: {
          effects: {
            [newEffect.effectInstanceId]: {
              before: undefined,
              after: toEffectSnapshot(newEffect, isEffective),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, appliedEffect: newEffect, lastEventId: applied.eventId };
}
