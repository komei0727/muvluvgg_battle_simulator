import { MemorySelectionDialog } from "../features/catalog-selection/MemorySelectionDialog.js";
import { UnitSelectionDialog } from "../features/catalog-selection/UnitSelectionDialog.js";
import { MAX_UNITS_PER_SIDE } from "../features/formation/formation-reducer.js";
import { UnitEnhancementDialog } from "../features/formation/UnitEnhancementDialog.js";
import {
  createInitialUnitEnhancement,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import type {
  FormationAction,
  SelectionDialogState,
} from "../features/formation/formation-reducer.js";
import type { BattleDraft } from "../features/formation/types.js";
import type { UiViolation } from "../features/formation/draft-validation.js";
import type { BattleSimulationCatalogResponse } from "../features/simulation/api-contract.js";

export interface SelectionDialogsProps {
  readonly selectionDialog: SelectionDialogState;
  readonly draft: BattleDraft;
  readonly catalog: BattleSimulationCatalogResponse;
  readonly unitImageMap: Readonly<Record<string, string>>;
  readonly memoryImageMap: Readonly<Record<string, string>>;
  readonly violations: readonly UiViolation[];
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
  violations,
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

  if (selectionDialog.kind === "unitEnhancement") {
    const slotKey = selectionDialog.slotKey;
    const slot = [...draft.allySlots, ...draft.enemySlots].find((s) => s.slotKey === slotKey);
    const unit = catalog.units.find((u) => u.unitDefinitionId === slot?.unitDefinitionId);
    if (slot === undefined || unit === undefined) {
      return null;
    }
    return (
      <UnitEnhancementDialog
        unitDisplayName={unit.displayName}
        slotKey={slotKey}
        enhancement={slot.enhancement ?? createInitialUnitEnhancement()}
        violations={violations}
        onLevelChange={(value) => {
          dispatch({ type: "unitEnhancementLevelChanged", slotKey, value });
        }}
        onGearChange={(gearIndex, gear) => {
          dispatch({
            type: "unitEnhancementGearChanged",
            slotKey,
            gearIndex,
            ...(gear === undefined ? {} : { gear }),
          });
        }}
        onClose={() => {
          dispatch({ type: "selectionClosed" });
        }}
      />
    );
  }

  return null;
}
