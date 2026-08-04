import { MemorySelectionDialog } from "../features/catalog-selection/MemorySelectionDialog.js";
import { UnitSelectionDialog } from "../features/catalog-selection/UnitSelectionDialog.js";
import { MAX_UNITS_PER_SIDE } from "../features/formation/formation-reducer.js";
import { memorySlotsForSide, slotsForSide } from "../features/formation/types.js";
import type {
  FormationAction,
  SelectionDialogState,
} from "../features/formation/formation-reducer.js";
import type { BattleDraft } from "../features/formation/types.js";
import type { BattleSimulationCatalogResponse } from "../features/simulation/api-contract.js";

export interface SelectionDialogsProps {
  readonly selectionDialog: SelectionDialogState;
  readonly draft: BattleDraft;
  readonly catalog: BattleSimulationCatalogResponse;
  readonly unitImageMap: Readonly<Record<string, string>>;
  readonly memoryImageMap: Readonly<Record<string, string>>;
  readonly dispatch: (action: FormationAction) => void;
}

// 04_コンポーネント・状態管理設計.md §2: dialogはDOM上でPage直下に置き、起点slotは
// stateで参照する。呼び出し側はCatalogがreadyのときだけこれを描画する
// （`catalog.status !== "ready"`ではselection dialogを開始しない、§6）。
export function SelectionDialogs({
  selectionDialog,
  draft,
  catalog,
  unitImageMap,
  memoryImageMap,
  dispatch,
}: SelectionDialogsProps) {
  if (selectionDialog.kind === "unit") {
    const slotKey = selectionDialog.slotKey;
    const slot = [...draft.allySlots, ...draft.enemySlots].find((s) => s.slotKey === slotKey);
    if (slot === undefined) {
      return null;
    }
    const atCapacity =
      slotsForSide(draft, slot.side).filter((s) => s.unitDefinitionId !== undefined).length >=
      MAX_UNITS_PER_SIDE;
    return (
      <UnitSelectionDialog
        units={catalog.units}
        {...(slot.unitDefinitionId !== undefined
          ? { currentUnitDefinitionId: slot.unitDefinitionId }
          : {})}
        atCapacity={atCapacity}
        imageMap={unitImageMap}
        onSelect={(unitDefinitionId) => {
          dispatch({ type: "unitSelected", slotKey, unitDefinitionId });
        }}
        onRemove={() => {
          dispatch({ type: "unitRemoved", slotKey });
        }}
        onClose={() => {
          dispatch({ type: "selectionClosed" });
        }}
      />
    );
  }

  if (selectionDialog.kind === "memory") {
    const { side, index } = selectionDialog;
    const currentMemoryDefinitionId = memorySlotsForSide(draft, side)[index];
    return (
      <MemorySelectionDialog
        memories={catalog.memories}
        {...(currentMemoryDefinitionId !== undefined ? { currentMemoryDefinitionId } : {})}
        imageMap={memoryImageMap}
        onSelect={(memoryDefinitionId) => {
          dispatch({ type: "memorySelected", side, index, memoryDefinitionId });
        }}
        onRemove={() => {
          dispatch({ type: "memoryRemoved", side, index });
        }}
        onClose={() => {
          dispatch({ type: "selectionClosed" });
        }}
      />
    );
  }

  return null;
}
