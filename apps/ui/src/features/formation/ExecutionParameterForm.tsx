import { useId } from "react";
import type { LogLevel } from "./types.js";
import styles from "./ExecutionParameterForm.module.css";

export interface ExecutionParameterFormProps {
  readonly turnLimit: number | "";
  readonly logLevel: LogLevel;
  readonly endpoint: string;
  readonly disabled: boolean;
  readonly onTurnLimitChange: (value: number | "") => void;
  readonly onLogLevelChange: (value: LogLevel) => void;
}

const LOG_LEVELS: readonly LogLevel[] = ["SUMMARY", "DETAILED", "DIAGNOSTIC"];

// docs/ui-design/01_UI要求・画面設計.md §5.4: 実行パラメータ.
export function ExecutionParameterForm({
  turnLimit,
  logLevel,
  endpoint,
  disabled,
  onTurnLimitChange,
  onLogLevelChange,
}: ExecutionParameterFormProps) {
  const turnLimitId = useId();
  const logLevelId = useId();
  const diagnosticNoticeId = useId();

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
          onChange={(event) => {
            const raw = event.target.value;
            onTurnLimitChange(raw === "" ? "" : Number(raw));
          }}
        />
      </div>
      <div className={styles["field"]}>
        <label htmlFor={logLevelId}>ログレベル</label>
        <select
          id={logLevelId}
          value={logLevel}
          disabled={disabled}
          aria-describedby={logLevel === "DIAGNOSTIC" ? diagnosticNoticeId : undefined}
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
