import { useEffect, useState } from "react";
import type { UiViolation } from "./draft-validation.js";
import type {
  BattleSimulationCatalogResponse,
  FormationStatPreviewUnit,
} from "../simulation/api-contract.js";
import type { FormationSlotInput, UiColumn, UiRow } from "./types.js";
import { UnitSlot } from "./UnitSlot.js";
import styles from "./FormationGrid.module.css";

export interface FormationStatPreviewView {
  readonly status: "unavailable" | "loading" | "failed" | "ready";
  readonly bySlotKey?: ReadonlyMap<string, FormationStatPreviewUnit>;
}

export interface FormationGridProps {
  /** 同一陣営の6枠。前衛3・後衛3をこの中から座標で引く。 */
  readonly slots: readonly FormationSlotInput[];
  readonly catalog: BattleSimulationCatalogResponse;
  readonly violations: readonly UiViolation[];
  readonly disabled: boolean;
  readonly imageMap?: Readonly<Record<string, string>>;
  /**
   * UI-AC-027: 枠hover／focusで見せる開始時ステータス。値の算出はサーバー側。
   * 省略時は未取得扱い —— プレビューは編成入力の付加情報であり、これが無くても
   * 編成そのものは成立する。
   */
  readonly statPreview?: FormationStatPreviewView;
  readonly onOpenUnitSelection: (slotKey: string) => void;
  /** UI-AC-032: 同一陣営内のユニット移動・入れ替えintent。 */
  readonly onMoveUnit: (fromSlotKey: string, toSlotKey: string) => void;
  /**
   * ユニット強化を編集できる編成でだけ渡す。省略した編成（戦術演習の敵）は
   * 枠に強化ボタン自体を出さない。
   */
  readonly onOpenUnitEnhancement?: (slotKey: string) => void;
  readonly enhancementEnabled?: boolean;
}

const ROWS: readonly UiRow[] = ["FRONT", "REAR"];
const COLUMNS: readonly UiColumn[] = [0, 1, 2];
const ROW_LABELS: Readonly<Record<UiRow, string>> = {
  FRONT: "FRONT / 前衛",
  REAR: "REAR / 後衛",
};

function slotAt(
  slots: readonly FormationSlotInput[],
  row: UiRow,
  column: UiColumn,
): FormationSlotInput | undefined {
  return slots.find((slot) => slot.row === row && slot.column === column);
}

function hasErrorFor(violations: readonly UiViolation[], slotKey: string): boolean {
  return violations.some((v) => v.slotKey === slotKey && v.severity === "error");
}

function hasAptitudeWarningFor(violations: readonly UiViolation[], slotKey: string): boolean {
  return violations.some((v) => v.slotKey === slotKey && v.code === "APTITUDE_MISMATCH");
}

/**
 * docs/ui-design/01_UI要求・画面設計.md §5.1: 陣営1つ分の前衛3枠・後衛3枠と、
 * その中での移動モードを持つ。通常戦闘の両陣営（`FormationEditor`）と戦術演習の
 * 敵編成（`ExerciseEnemyFormation`）が同じ盤面・同じ移動操作を共有する。
 */
export function FormationGrid({
  slots,
  catalog,
  violations,
  disabled,
  imageMap,
  statPreview = { status: "unavailable" },
  onOpenUnitSelection,
  onMoveUnit,
  onOpenUnitEnhancement,
  enhancementEnabled,
}: FormationGridProps) {
  // UI-AC-032: 移動元slotKey。dragとキーボード移動モードで共用する。
  // stateが陣営別のgridインスタンスに閉じているため、反対陣営のslotは
  // 配置先にならない（同一陣営制約の実体）。
  const [moveSourceSlotKey, setMoveSourceSlotKey] = useState<string | null>(null);

  // 実行開始（disabled化）で移動モードが宙に残らないよう解除する。
  useEffect(() => {
    if (disabled) {
      setMoveSourceSlotKey(null);
    }
  }, [disabled]);

  // Escapeによる中止はフォーカス位置で限定しない（強化button・メモリー枠・
  // 学園レベル入力などへ移った後でも効く）ため、documentレベルで捕捉する。
  useEffect(() => {
    if (moveSourceSlotKey === null) {
      return undefined;
    }
    const cancelOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMoveSourceSlotKey(null);
      }
    };
    document.addEventListener("keydown", cancelOnEscape);
    return () => {
      document.removeEventListener("keydown", cancelOnEscape);
    };
  }, [moveSourceSlotKey]);

  const placeMove = (targetSlotKey: string): void => {
    if (moveSourceSlotKey !== null && moveSourceSlotKey !== targetSlotKey) {
      onMoveUnit(moveSourceSlotKey, targetSlotKey);
    }
    setMoveSourceSlotKey(null);
  };

  const moveSourceSlot =
    moveSourceSlotKey !== null
      ? slots.find((slot) => slot.slotKey === moveSourceSlotKey)
      : undefined;
  const moveSourceUnit =
    moveSourceSlot !== undefined
      ? catalog.units.find((u) => u.unitDefinitionId === moveSourceSlot.unitDefinitionId)
      : undefined;
  const moveAnnouncement =
    moveSourceSlot !== undefined && moveSourceUnit !== undefined
      ? `${moveSourceSlot.row === "FRONT" ? "前衛" : "後衛"}${moveSourceSlot.column + 1}の` +
        `${moveSourceUnit.displayName}を移動中。移動先の枠を選ぶか、Escapeで中止できます`
      : "";

  return (
    <>
      {/* 移動モードの進行状態を読み上げへ届ける（UI-CT-052）。 */}
      <p aria-live="polite" className={styles["visuallyHidden"]}>
        {moveAnnouncement}
      </p>

      <div className={styles["grid"]}>
        {ROWS.map((row) => (
          <div key={row} className={styles["rowGroup"]}>
            <p className={styles["rowLabel"]}>{ROW_LABELS[row]}</p>
            <div className={styles["rowSlots"]}>
              {COLUMNS.map((column) => {
                const slot = slotAt(slots, row, column);
                if (slot === undefined) {
                  return null;
                }
                const unit = catalog.units.find(
                  (u) => u.unitDefinitionId === slot.unitDefinitionId,
                );
                return (
                  <UnitSlot
                    key={slot.slotKey}
                    row={row}
                    column={column}
                    {...(unit !== undefined ? { unit } : {})}
                    aptitudeWarning={hasAptitudeWarningFor(violations, slot.slotKey)}
                    hasError={hasErrorFor(violations, slot.slotKey)}
                    disabled={disabled}
                    {...(imageMap !== undefined ? { imageMap } : {})}
                    onOpen={() => {
                      // 移動モード中はslot起動を「この枠へ配置」に読み替え、
                      // 移動元自身の起動は中止として扱う（UI-AC-032）。
                      if (moveSourceSlotKey === null) {
                        onOpenUnitSelection(slot.slotKey);
                      } else if (moveSourceSlotKey === slot.slotKey) {
                        setMoveSourceSlotKey(null);
                      } else {
                        placeMove(slot.slotKey);
                      }
                    }}
                    {...(onOpenUnitEnhancement !== undefined
                      ? {
                          onOpenEnhancement: () => {
                            onOpenUnitEnhancement(slot.slotKey);
                          },
                        }
                      : {})}
                    moveSource={moveSourceSlotKey === slot.slotKey}
                    moveTarget={
                      moveSourceSlotKey !== null && moveSourceSlotKey !== slot.slotKey && !disabled
                    }
                    onMoveStart={() => {
                      setMoveSourceSlotKey(slot.slotKey);
                    }}
                    onMoveCancel={() => {
                      setMoveSourceSlotKey(null);
                    }}
                    onMovePlace={() => {
                      placeMove(slot.slotKey);
                    }}
                    {...(enhancementEnabled !== undefined ? { enhancementEnabled } : {})}
                    statPreviewStatus={statPreview.status}
                    {...(() => {
                      const preview = statPreview.bySlotKey?.get(slot.slotKey);
                      return preview !== undefined ? { statPreview: preview } : {};
                    })()}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
