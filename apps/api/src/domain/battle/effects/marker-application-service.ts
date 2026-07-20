import { applyMarker, removeMarker, type ApplyMarkerRequest } from "./marker-state.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";

export interface MarkerServiceContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface MarkerServiceResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-EFF-10: `ApplyMarkerRequest`を対象ユニットへ適用する。既存Markerが無ければ
 * `MarkerApplied`、既存があれば`MarkerUpdated`を発行する（`ADD`/`KEEP_EXISTING`/
 * `REFRESH`/`REPLACE`いずれも同じ判定 — `marker-state.ts`の`applyMarker`が
 * `before`の有無で新規/更新を返す）。
 */
export function applyMarkerToUnit(
  context: MarkerServiceContext,
  units: readonly BattleUnit[],
  request: ApplyMarkerRequest,
  parentEventId: DomainEventId,
): MarkerServiceResult {
  const target = requireUnit(units, request.targetId);
  const result = applyMarker(target.markers, request);
  const nextUnits = units.map((u) =>
    u.battleUnitId === request.targetId ? { ...u, markers: result.markers } : u,
  );

  const recordCommon = {
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    rootEventId: context.rootEventId,
    sourceUnitId: request.sourceId,
    targetUnitIds: [request.targetId],
  };

  if (result.before === undefined) {
    const applied = context.recorder.record({
      eventType: "MarkerApplied",
      category: "FACT",
      ...recordCommon,
      parentEventId,
      payload: {
        markerId: request.markerId,
        sourceUnitId: request.sourceId,
        targetUnitId: request.targetId,
        stackCount: result.after.stackCount,
        ...(request.duration.definition.timeLimit !== undefined
          ? { durationUnit: request.duration.definition.timeLimit.unit }
          : {}),
      },
    });
    return { units: nextUnits, lastEventId: applied.eventId };
  }

  const updated = context.recorder.record({
    eventType: "MarkerUpdated",
    category: "FACT",
    ...recordCommon,
    parentEventId,
    payload: {
      markerId: request.markerId,
      targetUnitId: request.targetId,
      sourceUnitId: request.sourceId,
      stackBefore: result.before.stackCount,
      stackAfter: result.after.stackCount,
      ...(result.before.duration.timeLimitRemaining !== undefined
        ? { durationBefore: result.before.duration.timeLimitRemaining }
        : {}),
      ...(result.after.duration.timeLimitRemaining !== undefined
        ? { durationAfter: result.after.duration.timeLimitRemaining }
        : {}),
      policy: request.policy,
      linkedEffectGroupId: request.linkedEffectGroupId,
    },
  });
  return { units: nextUnits, lastEventId: updated.eventId };
}

export type MarkerRemovalReason =
  | "EXPLICIT_REMOVE"
  | "TIME_LIMIT"
  | "CONSUMPTION"
  | "SPECIAL_CONDITION"
  | "ZERO_STACK"
  | "LINKED_GROUP_CASCADE";

/** `RemoveMarkerPayload`: Markerを保有していれば解除し`MarkerRemoved`を発行する。保有していなければno-op。 */
export function removeMarkerFromUnit(
  context: MarkerServiceContext,
  units: readonly BattleUnit[],
  targetId: BattleUnitId,
  markerId: MarkerId,
  reason: MarkerRemovalReason,
  parentEventId: DomainEventId,
): MarkerServiceResult {
  const target = requireUnit(units, targetId);
  const result = removeMarker(target.markers, markerId);
  if (result.removed === undefined) {
    return { units, lastEventId: parentEventId };
  }
  const nextUnits = units.map((u) =>
    u.battleUnitId === targetId ? { ...u, markers: result.markers } : u,
  );
  const removed = context.recorder.record({
    eventType: "MarkerRemoved",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    targetUnitIds: [targetId],
    payload: { markerId, targetUnitId: targetId, reason },
  });
  return { units: nextUnits, lastEventId: removed.eventId };
}
