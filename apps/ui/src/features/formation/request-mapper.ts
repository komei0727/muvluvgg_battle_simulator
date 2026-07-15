// Mirrors docs/ui-design/03_API・データ連携設計.md §4-5 (coordinate conversion
// and request generation rules).

import { memorySlotKeyOf } from "./types.js";
import type { BattleDraft, FormationSlotInput, LogLevel, Side, UiColumn, UiRow } from "./types.js";

export interface BattleSimulationUnitRequest {
  readonly unitDefinitionId: string;
  readonly position: { readonly column: UiColumn; readonly row: UiRow };
}

export interface FormationRequest {
  readonly units: readonly BattleSimulationUnitRequest[];
  readonly memoryDefinitionIds: readonly string[];
}

export interface BattleSimulationRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly turnLimit: number;
  readonly options: { readonly logLevel: LogLevel };
}

export type RequestBuildResult =
  | {
      readonly ok: true;
      readonly request: BattleSimulationRequest;
      readonly allyUnitSlotKeys: readonly string[];
      readonly enemyUnitSlotKeys: readonly string[];
      // memoryDefinitionIds is compressed (empty slots removed), so its API
      // array index does not equal the UI memory slot index. These arrays are
      // index-aligned with the compressed array instead, mirroring
      // allyUnitSlotKeys/enemyUnitSlotKeys (UI-API-004).
      readonly allyMemorySlotKeys: readonly string[];
      readonly enemyMemorySlotKeys: readonly string[];
    }
  | { readonly ok: false };

const ROW_ORDER: Readonly<Record<UiRow, number>> = { FRONT: 0, REAR: 1 };

// The catalog's positionAptitudes vocabulary (FRONT/BACK) is display-only;
// the API always takes the UI row name (FRONT/REAR) verbatim.
function apiRowForUiRow(row: UiRow): UiRow {
  return row;
}

interface BuiltFormation {
  readonly formation: FormationRequest;
  readonly unitSlotKeys: readonly string[];
  readonly memorySlotKeys: readonly string[];
}

function buildFormation(
  side: Side,
  slots: readonly FormationSlotInput[],
  memoryDefinitionIds: readonly (string | undefined)[],
): BuiltFormation {
  const filled = slots.filter(
    (slot): slot is FormationSlotInput & { unitDefinitionId: string } =>
      slot.unitDefinitionId !== undefined,
  );
  const sorted = filled.toSorted((a, b) => {
    const rowDiff = ROW_ORDER[a.row] - ROW_ORDER[b.row];
    return rowDiff !== 0 ? rowDiff : a.column - b.column;
  });

  const filledMemories = memoryDefinitionIds
    .map((memoryDefinitionId, index) => ({ memoryDefinitionId, index }))
    .filter(
      (entry): entry is { memoryDefinitionId: string; index: number } =>
        entry.memoryDefinitionId !== undefined,
    );

  return {
    formation: {
      units: sorted.map((slot) => ({
        unitDefinitionId: slot.unitDefinitionId,
        position: { column: slot.column, row: apiRowForUiRow(slot.row) },
      })),
      memoryDefinitionIds: filledMemories.map((entry) => entry.memoryDefinitionId),
    },
    unitSlotKeys: sorted.map((slot) => slot.slotKey),
    memorySlotKeys: filledMemories.map((entry) => memorySlotKeyOf(side, entry.index)),
  };
}

export function buildBattleSimulationRequest(draft: BattleDraft): RequestBuildResult {
  if (draft.turnLimit === "" || !Number.isInteger(draft.turnLimit)) {
    return { ok: false };
  }

  const ally = buildFormation("ally", draft.allySlots, draft.allyMemoryDefinitionIds);
  const enemy = buildFormation("enemy", draft.enemySlots, draft.enemyMemoryDefinitionIds);

  return {
    ok: true,
    request: {
      allyFormation: ally.formation,
      enemyFormation: enemy.formation,
      turnLimit: draft.turnLimit,
      options: { logLevel: draft.logLevel },
    },
    allyUnitSlotKeys: ally.unitSlotKeys,
    enemyUnitSlotKeys: enemy.unitSlotKeys,
    allyMemorySlotKeys: ally.memorySlotKeys,
    enemyMemorySlotKeys: enemy.memorySlotKeys,
  };
}
