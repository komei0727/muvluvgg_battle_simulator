import type { MarkerState } from "../model/marker-state.js";
import type { ActionId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { MarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { DurationTimeUnit } from "../../catalog/definitions/catalog-enums.js";

export interface MarkerDurationChange {
  readonly markerId: MarkerId;
  readonly before: number;
  readonly after: number;
}

export interface MarkerDurationDecrementResult {
  readonly markers: readonly MarkerState[];
  readonly changes: readonly MarkerDurationChange[];
}

/** `effect-duration-decrement.ts`の`actionOwnerTriggerMatches`と同じ規則（R-EFF-04、`Duration.owner`）をMarkerへ適用する。 */
function actionOwnerTriggerMatches(marker: MarkerState, actingUnitId: BattleUnitId): boolean {
  const owner = marker.duration.definition.timeLimit?.owner ?? "EFFECT_TARGET";
  if (owner === "EFFECT_SOURCE") {
    return marker.sourceId === actingUnitId;
  }
  if (owner === "BATTLE") {
    return true;
  }
  return marker.targetId === actingUnitId;
}

function decrementTimeLimitedMarkers(
  markers: readonly MarkerState[],
  unit: DurationTimeUnit,
  wasGrantedInCurrentScope: (marker: MarkerState) => boolean,
  triggersFor: (marker: MarkerState) => boolean,
): MarkerDurationDecrementResult {
  const changes: MarkerDurationChange[] = [];
  const next = markers.map((marker) => {
    const remaining = marker.duration.timeLimitRemaining;
    if (
      marker.duration.definition.timeLimit?.unit !== unit ||
      remaining === undefined ||
      remaining <= 0 ||
      wasGrantedInCurrentScope(marker) ||
      !triggersFor(marker)
    ) {
      return marker;
    }
    const after = remaining - 1;
    changes.push({ markerId: marker.markerId, before: remaining, after });
    return { ...marker, duration: { ...marker.duration, timeLimitRemaining: after } };
  });
  return { markers: next, changes };
}

/** `effect-duration-decrement.ts`の`decrementActionEffectDurations`と同じ規則をMarkerへ適用する（R-EFF-04、R-EFF-10）。 */
export function decrementActionMarkerDurations(
  markers: readonly MarkerState[],
  currentActionId: ActionId,
  actingUnitId: BattleUnitId,
): MarkerDurationDecrementResult {
  return decrementTimeLimitedMarkers(
    markers,
    "ACTION",
    (marker) => marker.duration.grantedActionId === currentActionId,
    (marker) => actionOwnerTriggerMatches(marker, actingUnitId),
  );
}

/** `effect-duration-decrement.ts`の`decrementTurnEffectDurations`と同じ規則をMarkerへ適用する（R-EFF-06、R-EFF-10）。 */
export function decrementTurnMarkerDurations(
  markers: readonly MarkerState[],
  currentTurnNumber: number,
): MarkerDurationDecrementResult {
  return decrementTimeLimitedMarkers(
    markers,
    "TURN",
    (marker) => marker.duration.grantedTurnNumber === currentTurnNumber,
    () => true,
  );
}
