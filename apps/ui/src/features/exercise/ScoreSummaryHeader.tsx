import { selectExerciseResultView } from "./exercise-result-projector.js";
import type { ExerciseResultResponse } from "../simulation/api-contract.js";
import styles from "./ScoreSummaryHeader.module.css";

export interface ScoreSummaryHeaderProps {
  readonly result: ExerciseResultResponse;
  readonly battleId: string;
  readonly catalogRevision: string;
}

// docs/ui-design/01_UI要求・画面設計.md `UI-UC-006` step 4 / `UI-CMP-012`:
// 勝敗の代わりに総スコア・ブレイク回数・終了理由を出す。演習は勝敗を持たない
// ため、`OutcomeStrip`の再利用ではなく専用のヘッダーにする。
export function ScoreSummaryHeader({ result, battleId, catalogRevision }: ScoreSummaryHeaderProps) {
  const view = selectExerciseResultView(result);

  return (
    <div className={styles["strip"]}>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>TOTAL SCORE</span>
        <div className={`${styles["value"]} ${styles["scoreValue"]}`}>
          {view.totalScore.toLocaleString()}
        </div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>BREAK COUNT</span>
        <div className={styles["value"]}>{view.breakCount.toLocaleString()}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>COMPLETION REASON</span>
        <div className={styles["value"]}>{view.completionReasonLabel}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>COMPLETED TURN</span>
        <div className={`${styles["value"]} ${styles["mono"]}`}>
          {view.completedTurn} / {view.turnLimit}
        </div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>BATTLE ID</span>
        <div className={`${styles["value"]} ${styles["mono"]}`}>{battleId}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>CATALOG REVISION</span>
        <div className={`${styles["value"]} ${styles["mono"]}`}>{catalogRevision}</div>
      </div>
    </div>
  );
}
