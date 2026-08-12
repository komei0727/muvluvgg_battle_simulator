import { useId } from "react";
import { EnhancementPanel } from "../formation/EnhancementPanel.js";
import type { UiViolation } from "../formation/draft-validation.js";
import { EXERCISE_ENEMY_SLOT_KEY } from "./exercise-enemy-slot-key.js";
import type { FormationSlotInput, SideEnhancementInput } from "../formation/types.js";
import type { FormationStatPreviewView } from "../formation/FormationEditor.js";
import { UnitSlot } from "../formation/UnitSlot.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import styles from "./ExerciseEnemySlot.module.css";

export interface ExerciseEnemySlotProps {
  /** draftの敵6枠をそのまま受け取り、描画する1枠だけをここで選ぶ。 */
  readonly slots: readonly FormationSlotInput[];
  readonly catalog: BattleSimulationCatalogResponse;
  readonly violations: readonly UiViolation[];
  readonly disabled: boolean;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly enhancement: SideEnhancementInput;
  readonly statPreview?: FormationStatPreviewView;
  readonly onOpenUnitSelection: (slotKey: string) => void;
  readonly onOpenUnitEnhancement: (slotKey: string) => void;
  readonly onEnhancementToggle: (side: "enemy", enabled: boolean) => void;
  readonly onAcademyLevelChange: (
    side: "enemy",
    group: "unitTypes" | "attributes",
    key: string,
    value: number | "",
  ) => void;
}

// docs/ui-design/01_UI要求・画面設計.md `UI-UC-006` step 2 / `UI-CMP-011`:
// 敵編成はユニット1枠だけを表示し、敵メモリー枠とターン上限入力を表示しない。
// ターン上限は5固定であることを明示する（`UI-AC-019`）。
export function ExerciseEnemySlot({
  slots,
  catalog,
  violations,
  disabled,
  imageMap,
  enhancement,
  statPreview = { status: "unavailable" },
  onOpenUnitSelection,
  onOpenUnitEnhancement,
  onEnhancementToggle,
  onAcademyLevelChange,
}: ExerciseEnemySlotProps) {
  const headingId = useId();
  const slot = slots.find((candidate) => candidate.slotKey === EXERCISE_ENEMY_SLOT_KEY);
  const unit = catalog.units.find(
    (candidate) => candidate.unitDefinitionId === slot?.unitDefinitionId,
  );
  const hasError = violations.some(
    (violation) => violation.slotKey === EXERCISE_ENEMY_SLOT_KEY && violation.severity === "error",
  );
  const aptitudeWarning = violations.some(
    (violation) =>
      violation.slotKey === EXERCISE_ENEMY_SLOT_KEY && violation.code === "APTITUDE_MISMATCH",
  );

  if (slot === undefined) {
    return null;
  }

  return (
    <section className={styles["side"]} aria-labelledby={headingId}>
      <div className={styles["heading"]}>
        <h3 id={headingId} className={styles["headingText"]}>
          ENEMY FORMATION
        </h3>
        <span className={styles["badge"]}>敵 / 1体</span>
      </div>

      <div className={styles["slot"]}>
        <UnitSlot
          row={slot.row}
          column={slot.column}
          {...(unit !== undefined ? { unit } : {})}
          aptitudeWarning={aptitudeWarning}
          hasError={hasError}
          disabled={disabled}
          {...(imageMap !== undefined ? { imageMap } : {})}
          onOpen={() => {
            onOpenUnitSelection(slot.slotKey);
          }}
          onOpenEnhancement={() => {
            onOpenUnitEnhancement(slot.slotKey);
          }}
          enhancementEnabled={enhancement.enabled}
          statPreviewStatus={statPreview.status}
          {...(() => {
            const preview = statPreview.bySlotKey?.get(slot.slotKey);
            return preview !== undefined ? { statPreview: preview } : {};
          })()}
        />
      </div>

      <p className={styles["notice"]}>
        戦術演習の敵はユニット1体のみで、敵メモリーは設定できません。ターン上限は5ターン固定です。
      </p>

      <EnhancementPanel
        side="enemy"
        enhancement={enhancement}
        violations={violations}
        disabled={disabled}
        onToggle={(enabled) => {
          onEnhancementToggle("enemy", enabled);
        }}
        onAcademyLevelChange={(group, key, value) => {
          onAcademyLevelChange("enemy", group, key, value);
        }}
      />
    </section>
  );
}
