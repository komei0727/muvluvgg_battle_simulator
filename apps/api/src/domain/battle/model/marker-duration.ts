import type { MarkerState } from "./marker-state.js";
import type { BattleUnit } from "./battle-unit.js";
import type { ActionId, MarkerInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `applied-effect-duration.ts`の`resolveTimeLimitOwnerUnitId`と同じ規則を
 * `MarkerState`へ適用する（R-EFF-04/06、R-EFF-10「同じDurationDefinitionを
 * 再利用する」）。
 */
const DEFAULT_TIME_LIMIT_OWNER = "EFFECT_TARGET";

export function resolveMarkerTimeLimitOwnerUnitId(marker: MarkerState): BattleUnitId | "BATTLE" {
  const owner = marker.duration.definition.timeLimit?.owner ?? DEFAULT_TIME_LIMIT_OWNER;
  if (owner === "BATTLE") {
    return "BATTLE";
  }
  return owner === "EFFECT_SOURCE" ? marker.sourceId : marker.targetId;
}

/** `applied-effect-duration.ts`の`EffectDurationChange`と同じ形の`MarkerState`版。 */
export interface MarkerDurationChange {
  readonly battleUnitId: BattleUnitId;
  readonly markerInstanceId: MarkerInstanceId;
  readonly unit: "ACTION" | "TURN";
  readonly before: number;
  readonly after: number;
}

export interface DecrementMarkerDurationsResult {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly MarkerDurationChange[];
}

function decrementDurations(
  units: readonly BattleUnit[],
  unit: "ACTION" | "TURN",
  isEligible: (marker: MarkerState) => boolean,
  wasGrantedInCurrentScope: (marker: MarkerState) => boolean,
): DecrementMarkerDurationsResult {
  const changes: MarkerDurationChange[] = [];
  const nextUnits = units.map((battleUnit) => {
    let changedInUnit = false;
    const nextMarkers = battleUnit.markerStates.map((marker) => {
      const timeLimit = marker.duration.definition.timeLimit;
      if (
        timeLimit?.unit !== unit ||
        marker.duration.timeLimitRemaining === undefined ||
        marker.duration.timeLimitRemaining <= 0 ||
        wasGrantedInCurrentScope(marker) ||
        !isEligible(marker)
      ) {
        return marker;
      }
      const before = marker.duration.timeLimitRemaining;
      const after = before - 1;
      changes.push({
        battleUnitId: battleUnit.battleUnitId,
        markerInstanceId: marker.markerInstanceId,
        unit,
        before,
        after,
      });
      changedInUnit = true;
      return { ...marker, duration: { ...marker.duration, timeLimitRemaining: after } };
    });
    return changedInUnit ? { ...battleUnit, markerStates: nextMarkers } : battleUnit;
  });
  return { units: nextUnits, changes };
}

/** R-EFF-04のMarker版（R-EFF-10）。`decrementActionEffectDurations`と同じ規則。 */
export function decrementActionMarkerDurations(
  units: readonly BattleUnit[],
  actingUnitId: BattleUnitId,
  currentActionId: ActionId,
): DecrementMarkerDurationsResult {
  return decrementDurations(
    units,
    "ACTION",
    (marker) => {
      const owner = resolveMarkerTimeLimitOwnerUnitId(marker);
      return owner === "BATTLE" || owner === actingUnitId;
    },
    (marker) => marker.duration.grantedActionId === currentActionId,
  );
}

/** R-EFF-06のMarker版（R-EFF-10）。`decrementTurnEffectDurations`と同じ規則。 */
export function decrementTurnMarkerDurations(
  units: readonly BattleUnit[],
  currentTurnNumber: number,
): DecrementMarkerDurationsResult {
  return decrementDurations(
    units,
    "TURN",
    () => true,
    (marker) => marker.duration.grantedTurnNumber === currentTurnNumber,
  );
}

/**
 * R-EFF-07相当の消費条件、および特殊失効条件（R-EFF-08相当）は、`DurationDefinition`
 * が型として許容していても現状のproduction Catalogに`APPLY_MARKER`が
 * `consumption`/`expiration`を指定する行が存在しないため、この関数群では扱わない
 * （R-EFF-08が`AppliedEffect`について同じ理由でproduction Catalog検証対象を
 * 持たないのと同じ判断）。利用するproduction定義が現れた時点で
 * `applied-effect-duration.ts`の`consumeEffectDurations`と対称な実装を追加する。
 */
