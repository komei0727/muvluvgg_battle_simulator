import { MemorySelectionDialog } from "../features/catalog-selection/MemorySelectionDialog.js";
import { UnitSelectionDialog } from "../features/catalog-selection/UnitSelectionDialog.js";
import { selectUnitPool } from "../features/catalog-selection/unit-pool.js";
import { MAX_UNITS_PER_SIDE } from "../features/formation/formation-reducer.js";
import { UnitEnhancementDialog } from "../features/formation/UnitEnhancementDialog.js";
import {
  createInitialUnitEnhancement,
  enhancementForSide,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import type {
  FormationAction,
  SelectionDialogState,
} from "../features/formation/formation-reducer.js";
import type { BattleDraft, Side, UnitEnhancementInput } from "../features/formation/types.js";
import type { UiViolation } from "../features/formation/draft-validation.js";
import type { BattleMode } from "../features/exercise/ModeTabs.js";
import type { BattleSimulationCatalogResponse } from "../features/simulation/api-contract.js";

export interface SelectionDialogsProps {
  readonly selectionDialog: SelectionDialogState;
  readonly draft: BattleDraft;
  /** R-TEX-11 #2 #3: ユニット選択の候補はモードと陣営の組で決まる。 */
  readonly mode: BattleMode;
  readonly catalog: BattleSimulationCatalogResponse;
  readonly unitImageMap: Readonly<Record<string, string>>;
  readonly memoryImageMap: Readonly<Record<string, string>>;
  readonly violations: readonly UiViolation[];
  /**
   * 手持ちデータからのプリフィル値（01_UI要求・画面設計.md §5.9）。dispatch前に
   * ストアを引き、actionのpayloadへ乗せる。敵枠は`undefined`を返す。
   */
  readonly prefillEnhancementFor: (
    side: Side,
    unitDefinitionId: string,
  ) => UnitEnhancementInput | undefined;
  readonly dispatch: (action: FormationAction) => void;
}

// 04_コンポーネント・状態管理設計.md §2: dialogはDOM上でPage直下に置き、起点slotは
// stateで参照する。呼び出し側はCatalogがreadyのときだけこれを描画する
// （`catalog.status !== "ready"`ではselection dialogを開始しない、§6）。
export function SelectionDialogs({
  selectionDialog,
  draft,
  mode,
  catalog,
  unitImageMap,
  memoryImageMap,
  violations,
  prefillEnhancementFor,
  dispatch,
}: SelectionDialogsProps) {
  if (selectionDialog.kind === "unit") {
    const slotKey = selectionDialog.slotKey;
    const slot = [...draft.allySlots, ...draft.enemySlots].find((s) => s.slotKey === slotKey);
    if (slot === undefined) {
      return null;
    }
    // R-TEX-01 #3 / UI-AC-019: 演習の敵はちょうど1体。空き枠を選んだときは
    // 置いていた1体をその枠へ移すので、上限到達として選択を塞がない。
    const exclusiveForSide = mode === "exercise" && slot.side === "enemy";
    const atCapacity =
      !exclusiveForSide &&
      slotsForSide(draft, slot.side).filter((s) => s.unitDefinitionId !== undefined).length >=
        MAX_UNITS_PER_SIDE;
    return (
      <UnitSelectionDialog
        units={selectUnitPool(catalog.units, mode, slot.side)}
        {...(slot.unitDefinitionId !== undefined
          ? { currentUnitDefinitionId: slot.unitDefinitionId }
          : {})}
        atCapacity={atCapacity}
        imageMap={unitImageMap}
        onSelect={(unitDefinitionId) => {
          const enhancement = prefillEnhancementFor(slot.side, unitDefinitionId);
          dispatch({
            type: "unitSelected",
            slotKey,
            unitDefinitionId,
            ...(enhancement === undefined ? {} : { enhancement }),
            ...(exclusiveForSide ? { exclusiveForSide } : {}),
          });
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
        {...(catalog.gearEffects !== undefined ? { gearEffects: catalog.gearEffects } : {})}
        levelLink={enhancementForSide(draft, slot.side).levelLink}
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
        onLinkExclusionChange={(excluded) => {
          dispatch({ type: "unitLinkExclusionChanged", slotKey, excluded });
        }}
        onClose={() => {
          dispatch({ type: "selectionClosed" });
        }}
      />
    );
  }

  return null;
}
