import { useId } from "react";
import type { UiViolation } from "../formation/draft-validation.js";
import { FormationGrid } from "../formation/FormationGrid.js";
import type { FormationStatPreviewView } from "../formation/FormationGrid.js";
import type { FormationSlotInput } from "../formation/types.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";
import styles from "./ExerciseEnemyFormation.module.css";

export interface ExerciseEnemyFormationProps {
  /** draftの敵6枠。通常戦闘と同じ前衛3・後衛3の盤面をそのまま描画する。 */
  readonly slots: readonly FormationSlotInput[];
  readonly catalog: BattleSimulationCatalogResponse;
  readonly violations: readonly UiViolation[];
  readonly disabled: boolean;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly statPreview?: FormationStatPreviewView;
  readonly onOpenUnitSelection: (slotKey: string) => void;
  readonly onMoveUnit: (fromSlotKey: string, toSlotKey: string) => void;
}

// docs/ui-design/01_UI要求・画面設計.md `UI-UC-006` step 2 / `UI-CMP-011`:
// 敵編成は前衛3・後衛3の盤面を出し、そのうち1枠だけを埋める。位置は
// `POSITION_ROW`/`POSITION_COLUMN`条件や前後列優先の対象順が参照するため、
// 敵1体でも配置によって結果が変わる。敵メモリー枠とターン上限入力は出さず、
// ターン上限は5固定であることを明示する（`UI-AC-019`）。
//
// 敵の強化（学園レベル・ユニット強化）も表示しない。演習の敵はスコアを競う
// 相手として定義どおりの1体であり（`R-TEX-01` #1）、学園レベルは利用者自身の
// 育成情報だからである。リクエストの`enemyFormation`は`enhancement`を持たない。
export function ExerciseEnemyFormation({
  slots,
  catalog,
  violations,
  disabled,
  imageMap,
  statPreview = { status: "unavailable" },
  onOpenUnitSelection,
  onMoveUnit,
}: ExerciseEnemyFormationProps) {
  const headingId = useId();

  return (
    <section className={styles["side"]} aria-labelledby={headingId}>
      <div className={styles["heading"]}>
        <h3 id={headingId} className={styles["headingText"]}>
          ENEMY FORMATION
        </h3>
        <span className={styles["badge"]}>敵 / 1体</span>
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
      />

      <p className={styles["notice"]}>
        戦術演習の敵はユニット1体のみで、前衛・後衛の6枠から配置する枠を選べます。別の枠でユニットを選ぶと、置いていた1体がその枠へ移ります。敵メモリーと敵の強化は設定できません。ターン上限は5ターン固定です。
      </p>
    </section>
  );
}
