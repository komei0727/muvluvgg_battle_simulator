import { Button } from "../../components/Button.js";
import styles from "./SubmitControls.module.css";

export interface SubmitControlsProps {
  readonly canSubmit: boolean;
  readonly isSubmitting: boolean;
  /** モードごとの実行ラベル（通常戦闘／戦術演習）。 */
  readonly submitLabel?: string;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}

// docs/ui-design/01_UI要求・画面設計.md §5.5, §6 (実行中はボタンを無効化し
// 「実行中…」、キャンセルボタンを表示する)。
export function SubmitControls({
  canSubmit,
  isSubmitting,
  submitLabel = "戦闘を開始",
  onSubmit,
  onCancel,
}: SubmitControlsProps) {
  return (
    <div className={styles["controls"]}>
      <Button variant="primary" disabled={!canSubmit || isSubmitting} onClick={onSubmit}>
        {isSubmitting ? "実行中…" : submitLabel}
      </Button>
      {isSubmitting ? (
        <Button variant="secondary" onClick={onCancel}>
          キャンセル
        </Button>
      ) : null}
    </div>
  );
}
