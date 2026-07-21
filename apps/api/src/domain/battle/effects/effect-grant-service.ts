import {
  buildInitialDurationState,
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
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
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

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
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  readonly duplicate: boolean;
  readonly magnitude: number;
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
  const kindKey = effectKindKeyFromDefinitionId(request.effectActionDefinitionId);
  const timeLimit = request.durationDefinition.timeLimit;

  const newEffect: AppliedEffect = {
    effectInstanceId: context.recorder.nextEffectInstanceId(),
    effectActionDefinitionId: request.effectActionDefinitionId,
    kindKey,
    duplicate: request.duplicate,
    sourceId: request.sourceId,
    targetId: request.targetId,
    magnitude: request.magnitude,
    duration: buildInitialDurationState(request.durationDefinition, {
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      turnNumber: context.turnNumber,
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
    sourceUnitId: request.sourceId,
    targetUnitIds: [request.targetId],
    payload: {
      effectInstanceId: newEffect.effectInstanceId,
      effectActionDefinitionId: request.effectActionDefinitionId,
      sourceUnitId: request.sourceId,
      targetUnitId: request.targetId,
      duplicate: request.duplicate,
      kindKey,
      magnitude: request.magnitude,
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
