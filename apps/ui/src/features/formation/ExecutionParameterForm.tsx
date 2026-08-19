import { useId } from "react";
import type { UiViolation } from "./draft-validation.js";
import { MAX_EXERCISE_RUN_COUNT, MIN_EXERCISE_RUN_COUNT } from "./types.js";
import type { ExerciseExecutionInput, ExerciseExecutionMode, LogLevel } from "./types.js";
import styles from "./ExecutionParameterForm.module.css";

/**
 * UI-AC-041: 戦術演習の実行指定。この props を渡すと、ログレベル選択の代わりに
 * 実行モードの切替が出る（`fixedTurnLimit`と同じ「渡した側がモードを決める」分岐）。
 */
export interface ExerciseExecutionFormProps {
  readonly value: ExerciseExecutionInput;
  readonly onModeChange: (value: ExerciseExecutionMode) => void;
  readonly onRunCountChange: (value: number | "") => void;
  readonly onSeedChange: (value: string) => void;
}

export interface ExecutionParameterFormProps {
  readonly turnLimit: number | "";
  readonly logLevel: LogLevel;
  readonly endpoint: string;
  readonly disabled: boolean;
  readonly violations?: readonly UiViolation[];
  /**
   * UI-AC-019: 戦術演習はターン上限を持たないため、入力の代わりに固定値を示す。
   * 指定した場合`turnLimit`と`onTurnLimitChange`は使わない。
   */
  readonly fixedTurnLimit?: number;
  /**
   * 指定した場合`logLevel`と`onLogLevelChange`は使わない — 演習の単一実行は常に
   * `DETAILED`で送るため、選ばせるものが無い（`exercise-request-mapper.ts`）。
   */
  readonly exerciseExecution?: ExerciseExecutionFormProps;
  readonly onTurnLimitChange: (value: number | "") => void;
  readonly onLogLevelChange: (value: LogLevel) => void;
}

/**
 * ログ方針刷新2/3（Issue #464）: `SUMMARY`＝通常実行（勝敗＋ユニット別集計だけを
 * 見る大量実行）、`DETAILED`＝詳細ログ（効果発動を追う）の2択。`DIAGNOSTIC`は
 * `DETAILED`と同一挙動の非推奨値になったため選択肢から外す。
 */
const LOG_LEVELS: readonly LogLevel[] = ["SUMMARY", "DETAILED"];

const EXERCISE_EXECUTION_MODES: readonly ExerciseExecutionMode[] = ["SINGLE", "STATISTICS"];

const EXERCISE_EXECUTION_MODE_LABELS: Readonly<Record<ExerciseExecutionMode, string>> = {
  SINGLE: "単一実行（ログ確認）",
  STATISTICS: "統計実行（大量実行）",
};

function messagesForPath(violations: readonly UiViolation[], path: string): readonly string[] {
  return Array.from(
    new Set(
      violations
        .filter((violation) => violation.path === path && violation.severity === "error")
        .map((violation) => violation.message),
    ),
  );
}

function ExerciseExecutionModeField({
  execution,
  disabled,
}: {
  readonly execution: ExerciseExecutionFormProps;
  readonly disabled: boolean;
}) {
  const modeId = useId();
  const { value, onModeChange } = execution;

  return (
    <div className={styles["field"]}>
      <label htmlFor={modeId}>実行モード</label>
      <select
        id={modeId}
        value={value.mode}
        disabled={disabled}
        onChange={(event) => {
          onModeChange(event.target.value as ExerciseExecutionMode);
        }}
      >
        {EXERCISE_EXECUTION_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {EXERCISE_EXECUTION_MODE_LABELS[mode]}
          </option>
        ))}
      </select>
    </div>
  );
}

function ExerciseStatisticsFields({
  execution,
  disabled,
  violations,
}: {
  readonly execution: ExerciseExecutionFormProps;
  readonly disabled: boolean;
  readonly violations: readonly UiViolation[];
}) {
  const runCountId = useId();
  const seedId = useId();
  const runCountErrorId = useId();
  const seedHintId = useId();

  const { value, onRunCountChange, onSeedChange } = execution;
  // 送信前検証も評価APIの422も同じ`/runsPerCandidate`を指す（`exercise-draft-validation.ts`）。
  const runCountMessages = messagesForPath(violations, "/runsPerCandidate");

  return (
    <div className={styles["statisticsParameters"]}>
      <div className={styles["field"]}>
        <label htmlFor={runCountId}>実行回数</label>
        <input
          id={runCountId}
          type="number"
          min={MIN_EXERCISE_RUN_COUNT}
          max={MAX_EXERCISE_RUN_COUNT}
          value={value.runCount}
          disabled={disabled}
          aria-invalid={runCountMessages.length > 0}
          aria-describedby={runCountMessages.length > 0 ? runCountErrorId : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            onRunCountChange(raw === "" ? "" : Number(raw));
          }}
        />
        {runCountMessages.length > 0 ? (
          <p id={runCountErrorId} className={styles["fieldError"]}>
            {runCountMessages.join(" ")}
          </p>
        ) : null}
      </div>
      <div className={styles["field"]}>
        <label htmlFor={seedId}>シード</label>
        <input
          id={seedId}
          type="text"
          value={value.seed}
          disabled={disabled}
          aria-describedby={seedHintId}
          onChange={(event) => {
            onSeedChange(event.target.value);
          }}
        />
        <p id={seedHintId} className={styles["hint"]}>
          空欄なら自動生成します。
        </p>
      </div>
    </div>
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
  fixedTurnLimit,
  exerciseExecution,
  onTurnLimitChange,
  onLogLevelChange,
}: ExecutionParameterFormProps) {
  const turnLimitId = useId();
  const logLevelId = useId();
  const detailedNoticeId = useId();
  const turnLimitErrorId = useId();
  const logLevelErrorId = useId();

  const turnLimitMessages = messagesForPath(violations, "/turnLimit");
  const logLevelMessages = messagesForPath(violations, "/options/logLevel");

  return (
    <div className={styles["parameters"]}>
      {fixedTurnLimit === undefined ? (
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
      ) : (
        <div className={styles["field"]}>
          <span className={styles["endpointLabel"]}>ターン上限</span>
          <div className={styles["endpoint"]}>{fixedTurnLimit}ターン固定</div>
        </div>
      )}
      {exerciseExecution === undefined ? (
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
                : logLevel === "DETAILED"
                  ? detailedNoticeId
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
          {logLevel === "DETAILED" ? (
            <p id={detailedNoticeId} className={styles["notice"]}>
              DETAILEDはレスポンスが大きくなります。
            </p>
          ) : null}
        </div>
      ) : (
        <ExerciseExecutionModeField execution={exerciseExecution} disabled={disabled} />
      )}
      <div className={styles["field"]}>
        <span className={styles["endpointLabel"]}>API ENDPOINT</span>
        <div className={styles["endpoint"]}>{endpoint}</div>
      </div>
      {/* 統計実行のパラメータは行を分けて全幅で置く。上の3項目と同じ行へ混ぜると
          モードの切替でENDPOINTの位置が動き、読み取り専用の表示が入力に見える。 */}
      {exerciseExecution !== undefined && exerciseExecution.value.mode === "STATISTICS" ? (
        <ExerciseStatisticsFields
          execution={exerciseExecution}
          disabled={disabled}
          violations={violations}
        />
      ) : null}
    </div>
  );
}
