import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import { recomputeActiveEffects } from "./effect-duplicate-resolution.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
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
 * R-EFF-01/05: 新しい`AppliedEffect`インスタンスを対象へ付与し、`EffectApplied`
 * を発行する。重複なし効果グループの採用対象が変わった場合は続けて
 * `EffectiveEffectChanged`を発行する（R-EFF-05「採用中の最強効果が失効・
 * 解除された場合」と対称の「新規付与で最強効果が入れ替わった場合」）。
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

  const beforeActive = target.appliedEffects.find(
    (e) => e.kindKey === kindKey && !e.duplicate && e.active,
  );

  const newEffect: AppliedEffect = {
    effectInstanceId: context.recorder.nextEffectInstanceId(),
    effectActionDefinitionId: request.effectActionDefinitionId,
    kindKey,
    duplicate: request.duplicate,
    sourceId: request.sourceId,
    targetId: request.targetId,
    magnitude: request.magnitude,
    active: true,
    duration: {
      definition: request.durationDefinition,
      ...(timeLimit !== undefined ? { timeLimitRemaining: timeLimit.count } : {}),
      ...(request.durationDefinition.consumption !== undefined
        ? { consumptionRemaining: request.durationDefinition.consumption.maxCount }
        : {}),
      ...(timeLimit?.unit === "ACTION" && context.actionId !== undefined
        ? { grantedActionId: context.actionId }
        : {}),
      ...(timeLimit?.unit === "TURN" ? { grantedTurnNumber: context.turnNumber } : {}),
    },
    ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}),
  };

  const recomputed = recomputeActiveEffects([...target.appliedEffects, newEffect]);
  const nextUnits = units.map((u) =>
    u.battleUnitId === request.targetId ? { ...u, appliedEffects: recomputed } : u,
  );
  const grantedEffect = recomputed.find((e) => e.effectInstanceId === newEffect.effectInstanceId)!;

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
      effectInstanceId: grantedEffect.effectInstanceId,
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
      ...(request.durationDefinition.consumption !== undefined
        ? {
            consumptionKind: request.durationDefinition.consumption.kind,
            consumptionMaxCount: request.durationDefinition.consumption.maxCount,
          }
        : {}),
      ...(grantedEffect.duration.grantedActionId !== undefined
        ? { grantedActionId: grantedEffect.duration.grantedActionId }
        : {}),
      ...(grantedEffect.duration.grantedTurnNumber !== undefined
        ? { grantedTurnNumber: grantedEffect.duration.grantedTurnNumber }
        : {}),
      ...(request.snapshot !== undefined ? { snapshot: request.snapshot } : {}),
    },
  });
  let lastEventId = applied.eventId;

  if (!request.duplicate) {
    const afterActive = recomputed.find((e) => e.kindKey === kindKey && !e.duplicate && e.active);
    if (beforeActive?.effectInstanceId !== afterActive?.effectInstanceId) {
      const changed = context.recorder.record({
        eventType: "EffectiveEffectChanged",
        category: "FACT",
        turnNumber: context.turnNumber,
        cycleNumber: context.cycleNumber,
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
        resolutionScopeId: context.resolutionScopeId,
        parentEventId: lastEventId,
        rootEventId: context.rootEventId,
        targetUnitIds: [request.targetId],
        payload: {
          targetUnitId: request.targetId,
          kindKey,
          ...(beforeActive !== undefined
            ? { beforeEffectInstanceId: beforeActive.effectInstanceId }
            : {}),
          ...(afterActive !== undefined
            ? { afterEffectInstanceId: afterActive.effectInstanceId }
            : {}),
        },
      });
      lastEventId = changed.eventId;
    }
  }

  return { units: nextUnits, appliedEffect: grantedEffect, lastEventId };
}
