import { useId } from "react";
import type { UiViolation } from "./draft-validation.js";
import type { LogLevel } from "./types.js";
import styles from "./ExecutionParameterForm.module.css";

export interface ExecutionParameterFormProps {
  readonly turnLimit: number | "";
  readonly logLevel: LogLevel;
  readonly endpoint: string;
  readonly disabled: boolean;
  readonly violations?: readonly UiViolation[];
  readonly onTurnLimitChange: (value: number | "") => void;
  readonly onLogLevelChange: (value: LogLevel) => void;
}

const LOG_LEVELS: readonly LogLevel[] = ["SUMMARY", "DETAILED", "DIAGNOSTIC"];

function messagesForPath(violations: readonly UiViolation[], path: string): readonly string[] {
  return Array.from(
    new Set(
      violations
        .filter((violation) => violation.path === path && violation.severity === "error")
        .map((violation) => violation.message),
    ),
  );
}

// docs/ui-design/01_UI要求・画面設計.md §5.4: 実行パラメータ.
// 03_API・データ連携設計.md §13, UI-CT-016: /turnLimit・/options/logLevelの
// server violationも該当fieldへ対応づける。
export function ExecutionParameterForm({
  turnLimit,
  logLevel,
  endpoint,
  disabled,
  violations = [],
  onTurnLimitChange,
  onLogLevelChange,
}: ExecutionParameterFormProps) {
  const turnLimitId = useId();
  const logLevelId = useId();
  const diagnosticNoticeId = useId();
  const turnLimitErrorId = useId();
  const logLevelErrorId = useId();

  const turnLimitMessages = messagesForPath(violations, "/turnLimit");
  const logLevelMessages = messagesForPath(violations, "/options/logLevel");

  return (
    <div className={styles["parameters"]}>
      <div className={styles["field"]}>
        <label htmlFor={turnLimitId}>ターン上限</label>
        <input
          id={turnLimitId}
          type="number"
          min={1}
          max={99}
          value={turnLimit}
          disabled={disabled}
          aria-invalid={turnLimitMessages.length > 0}
          aria-describedby={turnLimitMessages.length > 0 ? turnLimitErrorId : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            onTurnLimitChange(raw === "" ? "" : Number(raw));
          }}
        />
        {turnLimitMessages.length > 0 ? (
          <p id={turnLimitErrorId} className={styles["fieldError"]}>
            {turnLimitMessages.join(" ")}
          </p>
        ) : null}
      </div>
      <div className={styles["field"]}>
        <label htmlFor={logLevelId}>ログレベル</label>
        <select
          id={logLevelId}
          value={logLevel}
          disabled={disabled}
          aria-invalid={logLevelMessages.length > 0}
          aria-describedby={
            logLevelMessages.length > 0
              ? logLevelErrorId
              : logLevel === "DIAGNOSTIC"
                ? diagnosticNoticeId
                : undefined
          }
          onChange={(event) => {
            onLogLevelChange(event.target.value as LogLevel);
          }}
        >
          {LOG_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        {logLevelMessages.length > 0 ? (
          <p id={logLevelErrorId} className={styles["fieldError"]}>
            {logLevelMessages.join(" ")}
          </p>
        ) : null}
        {logLevel === "DIAGNOSTIC" ? (
          <p id={diagnosticNoticeId} className={styles["notice"]}>
            DIAGNOSTICはレスポンスが大きくなります。
          </p>
        ) : null}
      </div>
      <div className={styles["field"]}>
        <span className={styles["endpointLabel"]}>API ENDPOINT</span>
        <div className={styles["endpoint"]}>{endpoint}</div>
      </div>
    </div>
  );
}
