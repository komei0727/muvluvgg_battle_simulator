import { MemorySelectionDialog } from "../features/catalog-selection/MemorySelectionDialog.js";
import { UnitSelectionDialog } from "../features/catalog-selection/UnitSelectionDialog.js";
import { selectUnitPool } from "../features/catalog-selection/unit-pool.js";
import { MAX_UNITS_PER_SIDE } from "../features/formation/formation-reducer.js";
import { isSlotLevelLinked } from "../features/formation/level-link.js";
import { UnitEnhancementDialog } from "../features/formation/UnitEnhancementDialog.js";
import {
  createInitialUnitEnhancement,
  enhancementForSide,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import type { BattleDraft } from "../entities/battle-draft.js";
import type { BattleMode } from "../entities/battle-mode.js";
import type { UiViolation } from "../entities/violation.js";
import type { BattleSimulationCatalogResponse } from "../shared/api/api-contract.js";
import type {
  FormationAction,
  SelectionDialogState,
} from "../features/formation/formation-reducer.js";
import type { PlayerEnhancementAction } from "../features/formation/player-enhancement-reducer.js";

export interface SelectionDialogsProps {
  readonly selectionDialog: SelectionDialogState;
  readonly draft: BattleDraft;
  /** R-TEX-11 #2 #3: ユニット選択の候補はモードと陣営の組で決まる。 */
  readonly mode: BattleMode;
  readonly catalog: BattleSimulationCatalogResponse;
  readonly unitImageMap: Readonly<Record<string, string>>;
  readonly memoryImageMap: Readonly<Record<string, string>>;
  readonly violations: readonly UiViolation[];
  /** 編成枠・実行パラメータなど、モード別draftへ効くaction。 */
  readonly dispatch: (action: FormationAction) => void;
  /**
   * 味方のユニット強化編集（学園レベル・レベルリンクの外の、ユニット単位の
   * 編集）が向かう先。モードに依らない単一slice（REF-058 / Issue #603）。
   */
  readonly playerEnhancementDispatch: (action: PlayerEnhancementAction) => void;
  readonly onClose: () => void;
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
  dispatch,
  playerEnhancementDispatch,
  onClose,
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
          // 味方のユニット強化は`unitDefinitionId`単位の単一sliceから読むため
          // （REF-058 / Issue #603）、配置時のプリフィルは不要——どの枠へ置いても
          // 同じ記録を指す。
          dispatch({
            type: "unitSelected",
            slotKey,
            unitDefinitionId,
            ...(exclusiveForSide ? { exclusiveForSide } : {}),
          });
          onClose();
        }}
        onRemove={() => {
          dispatch({ type: "unitRemoved", slotKey });
          onClose();
        }}
        onClose={onClose}
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
          onClose();
        }}
        onRemove={() => {
          dispatch({ type: "memoryRemoved", side, index });
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  if (selectionDialog.kind === "unitEnhancement") {
    const slotKey = selectionDialog.slotKey;
    const slot = [...draft.allySlots, ...draft.enemySlots].find((s) => s.slotKey === slotKey);
    const unit = catalog.units.find((u) => u.unitDefinitionId === slot?.unitDefinitionId);
    if (slot === undefined || unit === undefined || slot.unitDefinitionId === undefined) {
      return null;
    }
    const { unitDefinitionId, side } = slot;
    return (
      <UnitEnhancementDialog
        unitDisplayName={unit.displayName}
        slotKey={slotKey}
        enhancement={slot.enhancement ?? createInitialUnitEnhancement()}
        violations={violations}
        {...(catalog.gearEffects !== undefined ? { gearEffects: catalog.gearEffects } : {})}
        sideEnhancement={enhancementForSide(draft, side)}
        onLevelChange={(value) => {
          if (side === "ally") {
            playerEnhancementDispatch({
              type: "unitEnhancementLevelChanged",
              unitDefinitionId,
              value,
            });
            return;
          }
          dispatch({ type: "unitEnhancementLevelChanged", slotKey, value });
        }}
        onRankChange={(value) => {
          if (side === "ally") {
            playerEnhancementDispatch({
              type: "unitEnhancementRankChanged",
              unitDefinitionId,
              value,
            });
            return;
          }
          dispatch({ type: "unitEnhancementRankChanged", slotKey, value });
        }}
        onGearChange={(gearIndex, gear) => {
          if (side === "ally") {
            playerEnhancementDispatch({
              type: "unitEnhancementGearChanged",
              unitDefinitionId,
              gearIndex,
              ...(gear === undefined ? {} : { gear }),
            });
            return;
          }
          dispatch({
            type: "unitEnhancementGearChanged",
            slotKey,
            gearIndex,
            ...(gear === undefined ? {} : { gear }),
          });
        }}
        onLinkExclusionChange={(excluded) => {
          if (side === "ally") {
            const sideEnhancement = enhancementForSide(draft, side);
            // UI-AC-036: 外した瞬間、その時点のリンクレベルでユニットのレベルを
            // シードする（`formation-reducer.ts`の同actionと同じ規約）。
            const seeded = excluded && isSlotLevelLinked(slot, sideEnhancement);
            playerEnhancementDispatch({
              type: "unitLinkExclusionChanged",
              unitDefinitionId,
              excluded,
              ...(seeded ? { seedLevel: sideEnhancement.levelLink.level } : {}),
            });
            return;
          }
          dispatch({ type: "unitLinkExclusionChanged", slotKey, excluded });
        }}
        onClose={onClose}
      />
    );
  }

  return null;
}
