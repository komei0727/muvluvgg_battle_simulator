import { useEffect, useId, useState } from "react";
import type { UiViolation } from "./draft-validation.js";
import { EnhancementPanel } from "./EnhancementPanel.js";
import { MemorySlot } from "./MemorySlot.js";
import type {
  BattleSimulationCatalogResponse,
  FormationStatPreviewUnit,
} from "../simulation/api-contract.js";
import { memorySlotKeyOf } from "./types.js";
import type { FormationSlotInput, Side, SideEnhancementInput, UiColumn, UiRow } from "./types.js";
import { UnitSlot } from "./UnitSlot.js";
import styles from "./FormationEditor.module.css";

export interface FormationEditorProps {
  readonly side: Side;
  readonly slots: readonly FormationSlotInput[];
  readonly memoryDefinitionIds: readonly (string | undefined)[];
  readonly catalog: BattleSimulationCatalogResponse;
  readonly violations: readonly UiViolation[];
  readonly disabled: boolean;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly enhancement: SideEnhancementInput;
  /**
   * UI-AC-027: 枠hover／focusで見せる開始時ステータス。値の算出はサーバー側。
   * 省略時は未取得扱い —— プレビューは編成入力の付加情報であり、これが無くても
   * 編成そのものは成立する。
   */
  readonly statPreview?: FormationStatPreviewView;
  readonly onOpenUnitSelection: (slotKey: string) => void;
  readonly onOpenMemorySelection: (side: Side, index: number) => void;
  readonly onOpenUnitEnhancement: (slotKey: string) => void;
  /** UI-AC-029: 同一陣営内のユニット移動・入れ替えintent。 */
  readonly onMoveUnit: (fromSlotKey: string, toSlotKey: string) => void;
  readonly onEnhancementToggle: (side: Side, enabled: boolean) => void;
  readonly onAcademyLevelChange: (
    side: Side,
    group: "unitTypes" | "attributes",
    key: string,
    value: number | "",
  ) => void;
}

export interface FormationStatPreviewView {
  readonly status: "unavailable" | "loading" | "failed" | "ready";
  readonly bySlotKey?: ReadonlyMap<string, FormationStatPreviewUnit>;
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

// docs/ui-design/01_UI要求・画面設計.md §5.1/§5.3, §4 page composition.
export function FormationEditor({
  side,
  slots,
  memoryDefinitionIds,
  catalog,
  violations,
  disabled,
  imageMap,
  enhancement,
  statPreview = { status: "unavailable" },
  onOpenUnitSelection,
  onOpenMemorySelection,
  onOpenUnitEnhancement,
  onEnhancementToggle,
  onAcademyLevelChange,
  onMoveUnit,
}: FormationEditorProps) {
  const headingId = useId();
  const sideLabelEn = side === "ally" ? "ALLY" : "ENEMY";
  const sideLabelJa = side === "ally" ? "味方" : "敵";
  const sideClass = side === "ally" ? styles["ally"] : styles["enemy"];

  // UI-AC-029: 移動元slotKey。dragとキーボード移動モードで共用する。
  // stateが陣営別のeditorインスタンスに閉じているため、反対陣営のslotは
  // 配置先にならない（同一陣営制約の実体）。
  const [moveSourceSlotKey, setMoveSourceSlotKey] = useState<string | null>(null);

  // 実行開始（disabled化）で移動モードが宙に残らないよう解除する。
  useEffect(() => {
    if (disabled) {
      setMoveSourceSlotKey(null);
    }
  }, [disabled]);

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
    <section className={`${styles["side"] ?? ""} ${sideClass ?? ""}`} aria-labelledby={headingId}>
      <div className={styles["heading"]}>
        <h3 id={headingId} className={styles["headingText"]}>
          {sideLabelEn} FORMATION
        </h3>
        <span className={styles["badge"]}>{sideLabelJa}</span>
      </div>

      {/* 移動モードの進行状態を読み上げへ届ける（UI-CT-046）。 */}
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
                      // 移動元自身の起動は中止として扱う（UI-AC-029）。
                      if (moveSourceSlotKey === null) {
                        onOpenUnitSelection(slot.slotKey);
                      } else if (moveSourceSlotKey === slot.slotKey) {
                        setMoveSourceSlotKey(null);
                      } else {
                        placeMove(slot.slotKey);
                      }
                    }}
                    onOpenEnhancement={() => {
                      onOpenUnitEnhancement(slot.slotKey);
                    }}
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
                    enhancementEnabled={enhancement.enabled}
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

      <div className={styles["memoryArea"]}>
        <p className={styles["subheading"]}>{sideLabelEn} MEMORY / 0-6</p>
        <div className={styles["memoryGrid"]}>
          {memoryDefinitionIds.map((memoryDefinitionId, index) => {
            const memory = catalog.memories.find(
              (m) => m.memoryDefinitionId === memoryDefinitionId,
            );
            const memorySlotKey = memorySlotKeyOf(side, index);
            return (
              <MemorySlot
                key={index}
                index={index}
                {...(memory !== undefined ? { memory } : {})}
                hasError={hasErrorFor(violations, memorySlotKey)}
                disabled={disabled}
                {...(imageMap !== undefined ? { imageMap } : {})}
                onOpen={() => {
                  onOpenMemorySelection(side, index);
                }}
              />
            );
          })}
        </div>
      </div>

      <EnhancementPanel
        side={side}
        enhancement={enhancement}
        violations={violations}
        disabled={disabled}
        onToggle={(enabled) => {
          onEnhancementToggle(side, enabled);
        }}
        onAcademyLevelChange={(group, key, value) => {
          onAcademyLevelChange(side, group, key, value);
        }}
      />
    </section>
  );
}
