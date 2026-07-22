import { collectMarkerLinkedGroupCascade } from "../model/marker-linked-group.js";
import { requireUnit, type BattleUnit } from "../model/battle-unit.js";
import { toMarkerSnapshot } from "../events/state-delta.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { MarkerRemovalReason } from "../events/domain-event.js";
import type { MarkerDurationChange } from "../model/marker-duration.js";
import type {
  ActionId,
  DomainEventId,
  MarkerInstanceId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface RemoveMarkersContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * `duration-expiry-service.ts`の`emitEffectDurationReducedEvents`と同じ役割の
 * `MarkerState`版だが、`MarkerState`は専用の減算イベントを持たず`MarkerUpdated`
 * （`policy`省略）へ統合する（`domain-event.ts`の`MarkerUpdated`コメント参照）。
 */
export function emitMarkerDurationChangedEvents(
  context: RemoveMarkersContext,
  units: readonly BattleUnit[],
  changes: readonly MarkerDurationChange[],
  parentEventId: DomainEventId,
): DomainEventId {
  let lastEventId = parentEventId;
  for (const change of changes) {
    const holder = requireUnit(units, change.battleUnitId);
    const marker = holder.markerStates.find(
      (candidate) => candidate.markerInstanceId === change.markerInstanceId,
    )!;
    const updated = context.recorder.record({
      eventType: "MarkerUpdated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: change.battleUnitId,
      targetUnitIds: [change.battleUnitId],
      payload: {
        markerInstanceId: change.markerInstanceId,
        markerId: marker.markerId,
        targetUnitId: marker.targetId,
        sourceUnitId: marker.sourceId,
        stackBefore: marker.stackCount,
        stackAfter: marker.stackCount,
        linkedEffectGroupId: marker.duration.definition.linkedEffectGroupId,
        durationUnit: change.unit,
        remainingBefore: change.before,
        remainingAfter: change.after,
      },
      stateDelta: {
        units: {
          [change.battleUnitId]: {
            markers: {
              [change.markerInstanceId]: {
                before: {
                  ...toMarkerSnapshot(marker),
                  duration: { unit: change.unit, remaining: change.before },
                },
                after: toMarkerSnapshot(marker),
              },
            },
          },
        },
      },
    });
    lastEventId = updated.eventId;
  }
  return lastEventId;
}

/** `duration-expiry-service.ts`の`ExpirationSeedReason`と同じ役割のMarker版。 */
export type MarkerRemovalSeedReason = Exclude<
  MarkerRemovalReason,
  "LINKED_GROUP_CASCADE" | "CONSUMPTION" | "EXPIRATION_CONDITION"
>;

export interface MarkerRemovalSeed {
  readonly battleUnitId: BattleUnitId;
  readonly markerInstanceId: MarkerInstanceId;
  readonly reason: MarkerRemovalSeedReason;
}

export interface RemoveMarkersResult {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
}

/**
 * R-EFF-10「Markerが0スタックになった場合は解除」/R-EFF-09: `seeds`（明示的な
 * `REMOVE_MARKER`、または時間制限が0になったMarker）から、同じ`linkedEffectGroupId`
 * を共有する未除去のMarkerを`collectMarkerLinkedGroupCascade`でカスケードし、
 * `MarkerRemoved`をインスタンスごとに発行してから対象を除去する。`duration-
 * expiry-service.ts`の`expireEffects`と同じ順序規約（子を先に、親を最後に）。
 * `AppliedEffect`をまたぐカスケード（R-EFF-09の完全な範囲）は
 * `marker-linked-group.ts`のコメントのとおり本Issueの対象外。
 */
export function removeMarkers(
  context: RemoveMarkersContext,
  units: readonly BattleUnit[],
  seeds: readonly MarkerRemovalSeed[],
  parentEventId: DomainEventId,
): RemoveMarkersResult {
  if (seeds.length === 0) {
    return { units, lastEventId: parentEventId };
  }

  const seedIds = new Set(seeds.map((seed) => seed.markerInstanceId));
  const cascadeIds = collectMarkerLinkedGroupCascade(units, seedIds);
  const reasonById = new Map<
    MarkerInstanceId,
    { reason: MarkerRemovalReason; cascaded: boolean }
  >();
  for (const seed of seeds) {
    reasonById.set(seed.markerInstanceId, { reason: seed.reason, cascaded: false });
  }

  const cascadedOnlyOrdered: MarkerInstanceId[] = [];
  for (const unit of units) {
    for (const marker of unit.markerStates) {
      if (cascadeIds.has(marker.markerInstanceId) && !seedIds.has(marker.markerInstanceId)) {
        cascadedOnlyOrdered.push(marker.markerInstanceId);
        reasonById.set(marker.markerInstanceId, { reason: "LINKED_GROUP_CASCADE", cascaded: true });
      }
    }
  }
  const orderedInstanceIds = [
    ...cascadedOnlyOrdered,
    ...seeds.map((seed) => seed.markerInstanceId),
  ];

  let working = units;
  let lastEventId = parentEventId;

  for (const markerInstanceId of orderedInstanceIds) {
    const holder = working.find((unit) =>
      unit.markerStates.some((marker) => marker.markerInstanceId === markerInstanceId),
    );
    if (holder === undefined) {
      continue;
    }
    const target = requireUnit(working, holder.battleUnitId);
    const targetMarker = target.markerStates.find(
      (marker) => marker.markerInstanceId === markerInstanceId,
    )!;

    working = working.map((unit) =>
      unit.battleUnitId === target.battleUnitId
        ? {
            ...unit,
            markerStates: unit.markerStates.filter(
              (marker) => marker.markerInstanceId !== markerInstanceId,
            ),
          }
        : unit,
    );

    const info = reasonById.get(markerInstanceId)!;
    const removed = context.recorder.record({
      eventType: "MarkerRemoved",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
      ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: lastEventId,
      rootEventId: context.rootEventId,
      sourceUnitId: target.battleUnitId,
      targetUnitIds: [target.battleUnitId],
      payload: {
        markerInstanceId,
        markerId: targetMarker.markerId,
        targetUnitId: target.battleUnitId,
        reason: info.reason,
        linkedEffectGroupId: targetMarker.duration.definition.linkedEffectGroupId,
        cascaded: info.cascaded,
      },
      stateDelta: {
        units: {
          [target.battleUnitId]: {
            markers: {
              [markerInstanceId]: {
                before: toMarkerSnapshot(targetMarker),
                after: undefined,
              },
            },
          },
        },
      },
    });
    lastEventId = removed.eventId;
  }

  return { units: working, lastEventId };
}
