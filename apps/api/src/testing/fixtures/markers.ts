import { createMarkerId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createMarkerInstanceId } from "../../domain/shared/event-ids.js";
import type { BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { MarkerState } from "../../domain/battle/model/marker-state.js";

export interface TestMarkerOverrides {
  readonly stackCount?: number;
}

/**
 * 自分自身を発生源・対象とする最小のMarker保持状態。`applyMarker` の実経路を
 * 通さずに「既にマーカーを持っている」前提を作るためのもので、期限は
 * 「解除可能・連動グループなし・時間制限なし」に固定する。
 */
export function testMarker(
  unit: BattleUnit,
  markerIdValue: string,
  overrides: TestMarkerOverrides = {},
): MarkerState {
  return {
    markerInstanceId: createMarkerInstanceId("MARKER_INSTANCE_1"),
    markerId: createMarkerId(markerIdValue),
    sourceId: unit.battleUnitId,
    targetId: unit.battleUnitId,
    stackCount: overrides.stackCount ?? 1,
    stackMax: null,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
  };
}
