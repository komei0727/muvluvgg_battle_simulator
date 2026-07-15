import { useId } from "react";
import type { UiViolation } from "./draft-validation.js";
import { MemorySlot } from "./MemorySlot.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import { memorySlotKeyOf } from "./types.js";
import type { FormationSlotInput, Side, UiColumn, UiRow } from "./types.js";
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
  readonly onOpenUnitSelection: (slotKey: string) => void;
  readonly onOpenMemorySelection: (side: Side, index: number) => void;
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
  onOpenUnitSelection,
  onOpenMemorySelection,
}: FormationEditorProps) {
  const headingId = useId();
  const sideLabelEn = side === "ally" ? "ALLY" : "ENEMY";
  const sideLabelJa = side === "ally" ? "味方" : "敵";
  const sideClass = side === "ally" ? styles["ally"] : styles["enemy"];

  return (
    <section className={`${styles["side"] ?? ""} ${sideClass ?? ""}`} aria-labelledby={headingId}>
      <div className={styles["heading"]}>
        <h3 id={headingId} className={styles["headingText"]}>
          {sideLabelEn} FORMATION
        </h3>
        <span className={styles["badge"]}>{sideLabelJa}</span>
      </div>

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
                      onOpenUnitSelection(slot.slotKey);
                    }}
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
    </section>
  );
}
