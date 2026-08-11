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
  /** M11: 選択済み枠からユニット強化ダイアログを開く（UI-AC-025）。 */
  readonly onOpenEnhancement?: () => void;
  /** M11: 陣営の強化トグル。OFFの間は編集させない（UI-AC-026）。 */
  readonly enhancementEnabled?: boolean;
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
  onOpenEnhancement,
  enhancementEnabled = false,
}: UnitSlotProps) {
  const positionLabel = `${rowLabelJa(row)}${column + 1}`;
  const baseName =
    unit === undefined
      ? `${positionLabel}にユニットを追加`
      : `${positionLabel}: ${unit.displayName}を変更`;
  const accessibleName = hasError ? `${baseName}、入力エラーがあります` : baseName;

  const slotButton = (
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

  // 強化ボタンはスロットbuttonの入れ子にできないため、同じ枠を包むwrapperの
  // 兄弟として置く（選択ダイアログの起動操作は従来どおりスロット全体）。
  // wrapperはユニットの有無に関わらず常に描画する — 空↔選択済みで要素の
  // 階層が変わるとReactがslot buttonを作り直し、選択直後のfocus復帰
  // （UI-CT-004）が失われるため。
  if (onOpenEnhancement === undefined) {
    return slotButton;
  }

  return (
    <div className={styles["slotWithEnhancement"]}>
      {slotButton}
      {unit === undefined ? null : (
        <button
          type="button"
          className={styles["enhancementButton"]}
          onClick={onOpenEnhancement}
          disabled={disabled || !enhancementEnabled}
          aria-label={`${positionLabel}: ${unit.displayName}の強化を編集`}
        >
          強化
        </button>
      )}
    </div>
  );
}
