import { Button } from "../../components/Button.js";
import { describeStatisticsRunError } from "./use-exercise-statistics-run.js";
import type {
  ExerciseStatisticsRunError,
  ExerciseStatisticsRunState,
  StatisticsRunProgress,
} from "./use-exercise-statistics-run.js";
import styles from "./StatisticsRunFeedback.module.css";

export interface StatisticsRunFeedbackProps {
  readonly state: ExerciseStatisticsRunState;
  readonly onCancel: () => void;
  /** 完了した結果が、その後編集された編成のものではないこと（`UI-CMP-003`と同じ扱い）。 */
  readonly isDirty?: boolean;
  /** 結果を出したCatalogが、いま保持しているCatalogと違う版であること。 */
  readonly catalogRevisionMismatch?: boolean;
  readonly onReloadCatalog?: () => void;
}

const CATALOG_REVISION_MISMATCH_MESSAGE =
  "Catalogが更新されたため、この結果は表示できません。再読込してユニット・Memoryの選択を確認してください。";

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
 * 失敗の表示。種別ごとの案内（`03_API・データ連携設計.md` §13）を先に出し、サーバーの
 * 生message・violationsはその下へ**textとして**添える（HTMLとして解釈しない）。
 */
function ErrorDetail({ error }: { readonly error: ExerciseStatisticsRunError }) {
  const view = describeStatisticsRunError(error);
  return (
    <>
      <p>{view.guidance}</p>
      {view.detail !== undefined ? <p className={styles["meta"]}>{view.detail}</p> : null}
      {view.violations !== undefined && view.violations.length > 0 ? (
        <ul className={styles["violations"]}>
          {view.violations.map((violation, index) => (
            <li key={`${violation.path ?? ""}-${index.toString()}`}>
              {violation.path !== undefined ? `${violation.path}: ` : ""}
              {violation.message}
            </li>
          ))}
        </ul>
      ) : null}
      {view.diagnosticId !== undefined ? (
        <p className={styles["meta"]}>Diagnostic ID: {view.diagnosticId}</p>
      ) : null}
    </>
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
  isDirty,
}: {
  readonly completedRuns: number;
  readonly progress: StatisticsRunProgress;
  readonly seed: string;
  readonly isDirty: boolean;
}) {
  return (
    <>
      <p className={styles["meta"]}>
        <span>{completedRuns.toLocaleString()}試行を集計しました</span>
        <span>（要求 {progress.requestedRuns.toLocaleString()}試行）</span>
        <span>seed: {seed}</span>
      </p>
      {/* 実行後は編成を編集できるため、結果がいまの編成のものだと読めてしまう。 */}
      {isDirty ? <p className={styles["dirty"]}>この結果は変更前の条件です。</p> : null}
    </>
  );
}

// docs/ui-design/01_UI要求・画面設計.md §5.4「戦術演習の実行モード」/
// 05_非機能・アクセシビリティ設計.md §6: 進捗はaria-live="polite"で通知し、
// 緊急でない失敗にrole="alert"を乱用しない。統計実行の失敗は実行そのものが
// 止まっており、利用者が次の操作を選び直す必要があるためalertとする。
export function StatisticsRunFeedback({
  state,
  onCancel,
  isDirty = false,
  catalogRevisionMismatch = false,
  onReloadCatalog,
}: StatisticsRunFeedbackProps) {
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
        <ErrorDetail error={state.error} />
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
      {/* Catalogが切り替わった後の結果は、いま表示している定義と対応しない。数値だけを
          残すと別の編成の結果として読まれるため、要約ごと再読込の案内へ置き換える。 */}
      {catalogRevisionMismatch ? (
        <>
          <p>{CATALOG_REVISION_MISMATCH_MESSAGE}</p>
          {onReloadCatalog !== undefined ? (
            <div>
              <Button variant="secondary" onClick={onReloadCatalog}>
                Catalogを再読込
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <CompletedSummary
          completedRuns={state.aggregate.completedRuns}
          progress={state.progress}
          seed={state.seed}
          isDirty={isDirty}
        />
      )}
    </div>
  );
}
