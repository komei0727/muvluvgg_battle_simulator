import { Button } from "../../components/Button.js";
import { describeStatisticsRunError } from "./use-exercise-statistics-run.js";
import type {
  ExerciseStatisticsRunState,
  StatisticsRunProgress,
} from "./use-exercise-statistics-run.js";
import styles from "./StatisticsRunFeedback.module.css";

export interface StatisticsRunFeedbackProps {
  readonly state: ExerciseStatisticsRunState;
  readonly onCancel: () => void;
}

function ProgressLine({ progress }: { readonly progress: StatisticsRunProgress }) {
  return (
    <div className={styles["progressLine"]} aria-live="polite">
      <progress
        className={styles["bar"]}
        aria-label="統計実行の進捗"
        value={progress.completedRuns}
        max={progress.requestedRuns}
      />
      <span className={styles["counts"]}>
        {progress.completedRuns.toLocaleString()} / {progress.requestedRuns.toLocaleString()} 試行
      </span>
      <span className={styles["counts"]}>
        チャンク {Math.min(progress.completedChunks + 1, progress.chunkCount).toLocaleString()} /{" "}
        {progress.chunkCount.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * 完了した実行の要約。集計そのものの表示は後続Issueが担うため、ここは「何試行が
 * 統計へ入ったか」と再現に要るseedだけを出す。要求数と実試行数を並べるのは、期限
 * 到達の部分結果（Q-TEX-18）と中断を「要求どおり終わった」と読ませないためである。
 */
function CompletedSummary({
  completedRuns,
  progress,
  seed,
}: {
  readonly completedRuns: number;
  readonly progress: StatisticsRunProgress;
  readonly seed: string;
}) {
  return (
    <p className={styles["meta"]}>
      <span>{completedRuns.toLocaleString()}試行を集計しました</span>
      <span>（要求 {progress.requestedRuns.toLocaleString()}試行）</span>
      <span>seed: {seed}</span>
    </p>
  );
}

// docs/ui-design/01_UI要求・画面設計.md §5.4「戦術演習の実行モード」/
// 05_非機能・アクセシビリティ設計.md §6: 進捗はaria-live="polite"で通知し、
// 緊急でない失敗にrole="alert"を乱用しない。統計実行の失敗は実行そのものが
// 止まっており、利用者が次の操作を選び直す必要があるためalertとする。
export function StatisticsRunFeedback({ state, onCancel }: StatisticsRunFeedbackProps) {
  if (state.status === "idle") {
    return null;
  }

  if (state.status === "running") {
    return (
      <div className={`${styles["feedback"]} ${styles["running"]}`}>
        <ProgressLine progress={state.progress} />
        <div>
          <Button variant="secondary" onClick={onCancel}>
            中断して結果を見る
          </Button>
        </div>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className={`${styles["feedback"]} ${styles["failed"]}`} role="alert">
        <p>{describeStatisticsRunError(state.error)}</p>
      </div>
    );
  }

  const cancelled = state.status === "cancelled";
  return (
    <div
      className={`${styles["feedback"]} ${cancelled ? styles["cancelled"] : styles["succeeded"]}`}
      aria-live="polite"
    >
      <p>{cancelled ? "統計実行を中断しました。" : "統計実行が完了しました。"}</p>
      <CompletedSummary
        completedRuns={state.aggregate.completedRuns}
        progress={state.progress}
        seed={state.seed}
      />
    </div>
  );
}
