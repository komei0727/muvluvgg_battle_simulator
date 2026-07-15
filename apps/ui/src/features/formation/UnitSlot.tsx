import { DefinitionImage } from "../../components/DefinitionImage.js";
import type { CatalogUnitSummary } from "../simulation/api-contract.js";
import type { UiColumn, UiRow } from "./types.js";
import styles from "./UnitSlot.module.css";

export interface UnitSlotProps {
  readonly row: UiRow;
  readonly column: UiColumn;
  readonly unit?: CatalogUnitSummary;
  readonly aptitudeWarning: boolean;
  readonly hasError: boolean;
  readonly disabled: boolean;
  readonly imageMap?: Readonly<Record<string, string>>;
  readonly onOpen: () => void;
}

function rowLabelJa(row: UiRow): string {
  return row === "FRONT" ? "前衛" : "後衛";
}

// docs/ui-design/05_非機能・アクセシビリティ設計.md §6: 選択済みでも表示名を
// accessible nameへ含める(UI-CT-001/002)。
export function UnitSlot({
  row,
  column,
  unit,
  aptitudeWarning,
  hasError,
  disabled,
  imageMap,
  onOpen,
}: UnitSlotProps) {
  const positionLabel = `${rowLabelJa(row)}${column + 1}`;
  const baseName =
    unit === undefined
      ? `${positionLabel}にユニットを追加`
      : `${positionLabel}: ${unit.displayName}を変更`;
  const accessibleName = hasError ? `${baseName}、入力エラーがあります` : baseName;

  return (
    <button
      type="button"
      className={[
        styles["slot"],
        unit !== undefined ? styles["filled"] : undefined,
        hasError ? styles["error"] : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onOpen}
      disabled={disabled}
      aria-label={accessibleName}
    >
      {unit === undefined ? (
        <span className={styles["empty"]}>
          <span className={styles["plus"]} aria-hidden="true">
            ＋
          </span>
          UNIT {String(column + 1).padStart(2, "0")}
        </span>
      ) : (
        <>
          <DefinitionImage
            definitionId={unit.unitDefinitionId}
            displayName={unit.displayName}
            kind="unit"
            {...(imageMap !== undefined ? { imageMap } : {})}
          />
          <span className={styles["body"]}>
            <span className={styles["name"]}>{unit.displayName}</span>
            <span className={styles["tags"]}>
              <span className={styles["tag"]}>{unit.attribute}</span>
              <span className={styles["tag"]}>{unit.role}</span>
              {aptitudeWarning ? (
                <span className={`${styles["tag"] ?? ""} ${styles["warningTag"] ?? ""}`}>
                  適性外
                </span>
              ) : null}
            </span>
          </span>
        </>
      )}
    </button>
  );
}
