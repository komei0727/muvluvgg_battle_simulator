import { buildInitialDurationState } from "../model/applied-effect.js";
import {
  buildInitialMarkerState,
  clampMarkerStack,
  type MarkerState,
} from "../model/marker-state.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toMarkerSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { MarkerStackPolicy } from "../../catalog/definitions/catalog-enums.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

export interface ApplyMarkerContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

export interface ApplyMarkerRequest {
  readonly markerId: MarkerId;
  readonly sourceId: BattleUnitId;
  readonly targetId: BattleUnitId;
  readonly stackPolicy: MarkerStackPolicy;
  readonly stackMax: number | null;
  readonly durationDefinition: DurationDefinition;
}

export interface ApplyMarkerResult {
  readonly units: readonly BattleUnit[];
  readonly markerState: MarkerState;
  readonly lastEventId: DomainEventId;
}

function actionTurnDurationOf(
  marker: MarkerState,
): { readonly unit: "ACTION" | "TURN"; readonly remaining: number } | undefined {
  const timeLimit = marker.duration.definition.timeLimit;
  return (timeLimit?.unit === "ACTION" || timeLimit?.unit === "TURN") &&
    marker.duration.timeLimitRemaining !== undefined
    ? { unit: timeLimit.unit, remaining: marker.duration.timeLimitRemaining }
    : undefined;
}

/**
 * R-EFF-10: `APPLY_MARKER`のADD/KEEP_EXISTING/REFRESH/REPLACEを対象1件・
 * Marker1件単位で適用する。既存Markerが無い場合はいずれの方針でもスタック1の
 * 新規インスタンスを作り`MarkerApplied`を発行する。既存Markerがある場合の挙動は
 * 方針ごとに異なる：
 * - `ADD`: スタック数へ1加算し（`stack.max`でclamp）、Durationは変更しない。
 * - `KEEP_EXISTING`: 何も変更せず、イベントも発行しない（`CombatStatChanged`と
 *   同じ「変化が無ければ発行しない」規約）。
 * - `REFRESH`: スタック数を維持し、Durationだけ新しい定義から再構築する。
 * - `REPLACE`: スタック数を1へ、Duration・stackMaxを新しい定義で丸ごと置き換える。
 * `sourceId`はMarkerを最後に触れた付与者を表す監査用の値であり、インスタンス
 * 識別（`markerId` + `targetId`）には使わない — 複数の付与元から同じMarkerが
 * 付与されても対象ごとに単一の`MarkerState`へ積み上がる。
 */
export function applyMarker(
  context: ApplyMarkerContext,
  units: readonly BattleUnit[],
  request: ApplyMarkerRequest,
  parentEventId: DomainEventId,
): ApplyMarkerResult {
  const target = requireUnit(units, request.targetId);
  const existing = target.markerStates.find((marker) => marker.markerId === request.markerId);

  if (existing === undefined) {
    const markerState = buildInitialMarkerState(
      context.recorder.nextMarkerInstanceId(),
      request.markerId,
      request.sourceId,
      request.targetId,
      request.stackMax,
      request.durationDefinition,
      {
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        turnNumber: context.turnNumber,
      },
    );
    const nextUnits = units.map((unit) =>
      unit.battleUnitId === request.targetId
        ? { ...unit, markerStates: [...unit.markerStates, markerState] }
        : unit,
    );
    const timeLimit = request.durationDefinition.timeLimit;
    const applied = context.recorder.record({
      eventType: "MarkerApplied",
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
        markerInstanceId: markerState.markerInstanceId,
        markerId: request.markerId,
        sourceUnitId: request.sourceId,
        targetUnitId: request.targetId,
        stackCount: markerState.stackCount,
        stackMax: markerState.stackMax,
        linkedEffectGroupId: request.durationDefinition.linkedEffectGroupId,
        ...(timeLimit !== undefined
          ? { durationUnit: timeLimit.unit, initialRemaining: timeLimit.count }
          : {}),
        ...(markerState.duration.timeLimitRemaining !== undefined
          ? { remainingCount: markerState.duration.timeLimitRemaining }
          : {}),
        ...(timeLimit?.owner !== undefined ? { durationOwner: timeLimit.owner } : {}),
        ...(request.durationDefinition.consumption !== undefined
          ? {
              consumptionKind: request.durationDefinition.consumption.kind,
              consumptionMaxCount: request.durationDefinition.consumption.maxCount,
            }
          : {}),
        ...(markerState.duration.consumptionRemaining !== undefined
          ? { consumptionRemaining: markerState.duration.consumptionRemaining }
          : {}),
        ...(request.durationDefinition.expiration !== undefined
          ? { expirationConditions: request.durationDefinition.expiration.conditions }
          : {}),
      },
      stateDelta: {
        units: {
          [request.targetId]: {
            markers: {
              [markerState.markerInstanceId]: {
                before: undefined,
                after: toMarkerSnapshot(markerState),
              },
            },
          },
        },
      },
    });
    return { units: nextUnits, markerState, lastEventId: applied.eventId };
  }

  if (request.stackPolicy === "KEEP_EXISTING") {
    return { units, markerState: existing, lastEventId: parentEventId };
  }

  const stackBefore = existing.stackCount;
  const durationBefore = actionTurnDurationOf(existing);

  let nextMarker: MarkerState;
  if (request.stackPolicy === "ADD") {
    nextMarker = {
      ...existing,
      sourceId: request.sourceId,
      stackCount: clampMarkerStack(existing.stackCount + 1, request.stackMax),
      stackMax: request.stackMax,
    };
  } else if (request.stackPolicy === "REFRESH") {
    nextMarker = {
      ...existing,
      sourceId: request.sourceId,
      duration: buildInitialDurationState(request.durationDefinition, {
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        turnNumber: context.turnNumber,
      }),
    };
  } else {
    // REPLACE: 既存Markerを新しい定義内容で丸ごと置き換える。
    nextMarker = {
      ...existing,
      sourceId: request.sourceId,
      stackCount: clampMarkerStack(1, request.stackMax),
      stackMax: request.stackMax,
      duration: buildInitialDurationState(request.durationDefinition, {
        ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
        turnNumber: context.turnNumber,
      }),
    };
  }

  const nextUnits = units.map((unit) =>
    unit.battleUnitId === request.targetId
      ? {
          ...unit,
          markerStates: unit.markerStates.map((marker) =>
            marker.markerInstanceId === existing.markerInstanceId ? nextMarker : marker,
          ),
        }
      : unit,
  );

  const durationAfter = actionTurnDurationOf(nextMarker);
  const updated = context.recorder.record({
    eventType: "MarkerUpdated",
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
      markerInstanceId: nextMarker.markerInstanceId,
      markerId: request.markerId,
      targetUnitId: request.targetId,
      sourceUnitId: request.sourceId,
      policy: request.stackPolicy,
      stackBefore,
      stackAfter: nextMarker.stackCount,
      linkedEffectGroupId: nextMarker.duration.definition.linkedEffectGroupId,
      ...(durationAfter !== undefined ? { durationUnit: durationAfter.unit } : {}),
      ...(durationBefore !== undefined ? { remainingBefore: durationBefore.remaining } : {}),
      ...(durationAfter !== undefined ? { remainingAfter: durationAfter.remaining } : {}),
    },
    stateDelta: {
      units: {
        [request.targetId]: {
          markers: {
            [nextMarker.markerInstanceId]: {
              before: toMarkerSnapshot(existing),
              after: toMarkerSnapshot(nextMarker),
            },
          },
        },
      },
    },
  });

  return { units: nextUnits, markerState: nextMarker, lastEventId: updated.eventId };
}
