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
  // R-MEM-04（M7-008、Issue #176）: Memory由来のMarkerは付与者ユニットを持たない。
  // `catalog-integrity.ts`がMemoryの`timeLimit.owner: EFFECT_SOURCE`宣言自体を
  // 拒否するため通常ここへは到達しないが、`applied-effect-duration.ts`と同じく
  // 「減算契機を持たない」＝`BATTLE`扱いへ決定的にフォールバックする。
  return owner === "EFFECT_SOURCE" ? (marker.sourceUnitId ?? "BATTLE") : marker.targetUnitId;
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
 * `MARKER_STACK_DECAY_OVER_TIME`（Issue #674）: `resolveDecayOwnerUnitId`
 * （`shield-policy.ts`）と同じ規則を`MarkerState.decay`へ適用する。`decay`未宣言の
 * Markerは呼び出し前に除外されるため、ここでは`decay`が存在する前提で読む。
 */
function resolveMarkerStackDecayOwnerUnitId(marker: MarkerState): BattleUnitId | "BATTLE" {
  const owner = marker.decay?.owner ?? "EFFECT_TARGET";
  if (owner === "BATTLE") {
    return "BATTLE";
  }
  return owner === "EFFECT_SOURCE" ? (marker.sourceUnitId ?? "BATTLE") : marker.targetUnitId;
}

export interface MarkerStackDecayChange {
  readonly battleUnitId: BattleUnitId;
  readonly markerInstanceId: MarkerInstanceId;
  readonly stackBefore: number;
  readonly stackAfter: number;
}

export interface DecayMarkerStacksResult {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly MarkerStackDecayChange[];
}

/**
 * `SHIELD_DECAY_OVER_TIME`の`decayActionShields`（`shield-policy.ts`）と同じ
 * COMPLETING契機のMarker版。`decay`を宣言したMarkerのうち、`decayingStackCount`
 * （`decay`宣言付きの付与で積まれた分だけ）を上限に`stackCount`を減らす —
 * 同じMarkerへ`decay`未宣言の付与（例: スキル側の非逓減スタック）が積み増した
 * 分は`decayingStackCount`に含まれないため巻き込まない。
 *
 * `decrementDurations`と同じく、0になったインスタンスをこの関数自身は除去しない
 * （呼び出し側が`removeMarkers`へ`reason: "STACK_DECAY"`のseedとして渡す）。
 */
export function decayActionMarkerStacks(
  units: readonly BattleUnit[],
  actingUnitId: BattleUnitId,
): DecayMarkerStacksResult {
  const changes: MarkerStackDecayChange[] = [];
  const nextUnits = units.map((battleUnit) => {
    let changedInUnit = false;
    const nextMarkers = battleUnit.markerStates.map((marker) => {
      if (marker.decay === undefined || marker.decayingStackCount <= 0) {
        return marker;
      }
      const owner = resolveMarkerStackDecayOwnerUnitId(marker);
      if (owner !== "BATTLE" && owner !== actingUnitId) {
        return marker;
      }
      const step = Math.min(marker.decay.amount, marker.decayingStackCount);
      const stackAfter = Math.max(0, marker.stackCount - step);
      changes.push({
        battleUnitId: battleUnit.battleUnitId,
        markerInstanceId: marker.markerInstanceId,
        stackBefore: marker.stackCount,
        stackAfter,
      });
      changedInUnit = true;
      return {
        ...marker,
        stackCount: stackAfter,
        decayingStackCount: marker.decayingStackCount - step,
      };
    });
    return changedInUnit ? { ...battleUnit, markerStates: nextMarkers } : battleUnit;
  });
  return { units: nextUnits, changes };
}

/**
 * R-EFF-07相当の消費条件、および特殊失効条件（R-EFF-08相当）は、`DurationDefinition`
 * が型として許容していても現状のproduction Catalogに`APPLY_MARKER`が
 * `consumption`/`expiration`を指定する行が存在しないため、この関数群では扱わない
 * （R-EFF-08が`AppliedEffect`について同じ理由でproduction Catalog検証対象を
 * 持たないのと同じ判断）。利用するproduction定義が現れた時点で
 * `applied-effect-duration.ts`の`consumeEffectDurations`と対称な実装を追加する。
 */
