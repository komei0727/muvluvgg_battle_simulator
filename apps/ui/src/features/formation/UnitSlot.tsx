import { useId, useState } from "react";
import { DefinitionImage } from "../../components/DefinitionImage.js";
import type { CatalogUnitSummary, FormationStatPreviewUnit } from "../simulation/api-contract.js";
import type { UiColumn, UiRow } from "./types.js";
import { UnitStatPreview } from "./UnitStatPreview.js";
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
  /** UI-AC-027: 開始時ステータスの取得状態。 */
  readonly statPreviewStatus?: "unavailable" | "loading" | "failed" | "ready";
  readonly statPreview?: FormationStatPreviewUnit;
  /** UI-AC-032: この枠が移動元（drag中またはキーボード移動モード）。 */
  readonly moveSource?: boolean;
  /** UI-AC-032: 同陣営の別枠から移動が進行中で、この枠が配置先になれる。 */
  readonly moveTarget?: boolean;
  readonly onMoveStart?: () => void;
  readonly onMoveCancel?: () => void;
  readonly onMovePlace?: () => void;
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
  statPreviewStatus = "unavailable",
  statPreview,
  moveSource = false,
  moveTarget = false,
  onMoveStart,
  onMoveCancel,
  onMovePlace,
}: UnitSlotProps) {
  const previewId = useId();
  // UI-CMP-017: 表示のON/OFFだけをlocal stateで持つ（値はpropsで受け取る）。
  const [previewShown, setPreviewShown] = useState(false);
  // dragenter/dragleaveは子要素でも対発火するため、深度で在圏を判定する。
  const [dragOverDepth, setDragOverDepth] = useState(0);
  // 空き枠には算出対象が無いため出さない。
  const showsPreview = unit !== undefined && previewShown;
  const positionLabel = `${rowLabelJa(row)}${column + 1}`;
  const baseName =
    unit === undefined
      ? `${positionLabel}にユニットを追加`
      : `${positionLabel}: ${unit.displayName}を変更`;
  const accessibleName = hasError ? `${baseName}、入力エラーがあります` : baseName;

  // 空き枠は配置先にだけなれる（drag元にならない）。実行中はdrag不可。
  const draggable = unit !== undefined && !disabled && onMoveStart !== undefined;
  const moveInProgress = moveSource || moveTarget;
  const isDragOver = dragOverDepth > 0 && moveTarget;

  const cancelOnEscape = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && moveInProgress) {
      onMoveCancel?.();
    }
  };

  const slotButton = (
    <button
      type="button"
      className={[
        styles["slot"],
        unit !== undefined ? styles["filled"] : undefined,
        hasError ? styles["error"] : undefined,
        moveSource ? styles["moveSource"] : undefined,
        isDragOver ? styles["dropTarget"] : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onOpen}
      disabled={disabled}
      aria-label={accessibleName}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) {
          return;
        }
        // Firefoxはdragstartでのデータ設定が無いとdragを開始しない。
        // 移動元の同定はReact stateで行うため、値は読み戻さない。
        event.dataTransfer.setData("text/plain", accessibleName);
        event.dataTransfer.effectAllowed = "move";
        setPreviewShown(false);
        onMoveStart?.();
      }}
      onDragEnd={() => {
        setDragOverDepth(0);
        onMoveCancel?.();
      }}
      onDragEnter={() => {
        setDragOverDepth((depth) => depth + 1);
      }}
      onDragLeave={() => {
        setDragOverDepth((depth) => Math.max(0, depth - 1));
      }}
      onDragOver={(event) => {
        // preventDefaultしない枠へはブラウザがdropを拒否する — これが
        // 陣営跨ぎ・移動元自身・実行中への配置を防ぐ実体（UI-AC-032）。
        if (moveTarget) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        if (moveTarget) {
          event.preventDefault();
          setDragOverDepth(0);
          onMovePlace?.();
        }
      }}
      onKeyDown={cancelOnEscape}
      // UI-AC-027: マウスを持たない利用者へも同じ情報を届けるため、hoverと
      // focusの両方で表示し、slot buttonから説明として関連づける。
      {...(showsPreview ? { "aria-describedby": previewId } : {})}
      onMouseEnter={() => {
        setPreviewShown(true);
      }}
      onMouseLeave={() => {
        setPreviewShown(false);
      }}
      onFocus={() => {
        setPreviewShown(true);
      }}
      onBlur={() => {
        setPreviewShown(false);
      }}
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

  // 強化・移動ボタンはスロットbuttonの入れ子にできないため、同じ枠を包む
  // wrapperの兄弟として置く（選択ダイアログの起動操作は従来どおりスロット全体）。
  // wrapperはユニットの有無に関わらず常に描画する — 空↔選択済みで要素の
  // 階層が変わるとReactがslot buttonを作り直し、選択直後のfocus復帰
  // （UI-CT-004）が失われるため。
  const preview = showsPreview ? (
    <UnitStatPreview
      id={previewId}
      status={statPreviewStatus}
      {...(statPreview !== undefined ? { unit: statPreview } : {})}
    />
  ) : null;

  const enhancementButton =
    onOpenEnhancement !== undefined && unit !== undefined ? (
      <button
        type="button"
        className={styles["enhancementButton"]}
        onClick={onOpenEnhancement}
        disabled={disabled || !enhancementEnabled}
        aria-label={`${positionLabel}: ${unit.displayName}の強化を編集`}
      >
        強化
      </button>
    ) : null;

  const moveButton =
    onMoveStart !== undefined && unit !== undefined ? (
      <button
        type="button"
        className={styles["moveButton"]}
        onClick={() => {
          if (moveSource) {
            onMoveCancel?.();
          } else {
            onMoveStart();
          }
        }}
        onKeyDown={cancelOnEscape}
        disabled={disabled}
        aria-pressed={moveSource}
        aria-label={
          moveSource
            ? `${positionLabel}: ${unit.displayName}の移動をキャンセル`
            : `${positionLabel}: ${unit.displayName}を移動`
        }
      >
        移動
      </button>
    ) : null;

  return (
    <div className={styles["slotWithEnhancement"]}>
      {slotButton}
      {preview}
      {enhancementButton !== null || moveButton !== null ? (
        <div className={styles["slotActions"]}>
          {enhancementButton}
          {moveButton}
        </div>
      ) : null}
    </div>
  );
}
