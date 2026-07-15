import type { UiViolation } from "./draft-validation.js";
import styles from "./ValidationSummary.module.css";

export interface ValidationSummaryProps {
  readonly violations: readonly UiViolation[];
}

function uniqueMessages(violations: readonly UiViolation[]): readonly string[] {
  return Array.from(new Set(violations.map((violation) => violation.message)));
}

// docs/ui-design/01_UI要求・画面設計.md §6 (入力エラー): 送信前に全違反を集約表示する。
export function ValidationSummary({ violations }: ValidationSummaryProps) {
  const errors = uniqueMessages(violations.filter((v) => v.severity === "error"));
  const warnings = uniqueMessages(violations.filter((v) => v.severity === "warning"));

  if (errors.length === 0 && warnings.length === 0) {
    return null;
  }

  return (
    <div className={styles["summary"]} aria-live="polite">
      {errors.length > 0 ? (
        <div role="alert" className={styles["errors"]}>
          <p className={styles["heading"]}>入力エラー</p>
          <ul className={styles["list"]}>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className={styles["warnings"]}>
          <p className={styles["heading"]}>警告</p>
          <ul className={styles["list"]}>
            {warnings.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
