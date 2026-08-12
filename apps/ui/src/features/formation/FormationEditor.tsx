import { useId } from "react";
import type { UiViolation } from "./draft-validation.js";
import { EnhancementPanel } from "./EnhancementPanel.js";
import { FormationGrid } from "./FormationGrid.js";
import type { FormationStatPreviewView } from "./FormationGrid.js";
import { MemorySlot } from "./MemorySlot.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import { memorySlotKeyOf } from "./types.js";
import type { FormationSlotInput, Side, SideEnhancementInput } from "./types.js";
import styles from "./FormationEditor.module.css";

export type { FormationStatPreviewView };

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
  /** UI-AC-032: 同一陣営内のユニット移動・入れ替えintent。 */
  readonly onMoveUnit: (fromSlotKey: string, toSlotKey: string) => void;
  readonly onEnhancementToggle: (side: Side, enabled: boolean) => void;
  readonly onAcademyLevelChange: (
    side: Side,
    group: "unitTypes" | "attributes",
    key: string,
    value: number | "",
  ) => void;
}

function hasErrorFor(violations: readonly UiViolation[], slotKey: string): boolean {
  return violations.some((v) => v.slotKey === slotKey && v.severity === "error");
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

  return (
    <section className={`${styles["side"] ?? ""} ${sideClass ?? ""}`} aria-labelledby={headingId}>
      <div className={styles["heading"]}>
        <h3 id={headingId} className={styles["headingText"]}>
          {sideLabelEn} FORMATION
        </h3>
        <span className={styles["badge"]}>{sideLabelJa}</span>
      </div>

      <FormationGrid
        slots={slots}
        catalog={catalog}
        violations={violations}
        disabled={disabled}
        {...(imageMap !== undefined ? { imageMap } : {})}
        statPreview={statPreview}
        onOpenUnitSelection={onOpenUnitSelection}
        onMoveUnit={onMoveUnit}
        onOpenUnitEnhancement={onOpenUnitEnhancement}
        enhancementEnabled={enhancement.enabled}
      />

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
