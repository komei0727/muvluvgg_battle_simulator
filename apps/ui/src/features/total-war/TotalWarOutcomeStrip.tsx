import type { TotalWarResultView } from "./total-war-result-projector.js";
import styles from "./TotalWarOutcomeStrip.module.css";

export interface TotalWarOutcomeStripProps {
  readonly view: TotalWarResultView;
}

// docs/ui-design/01_UI要求・画面設計.md §7.5「結果ヘッダー」（UI-AC-061）。文言の辞書は
// `selectTotalWarResultView`が持ち、ここは描画だけを担う。
export function TotalWarOutcomeStrip({ view }: TotalWarOutcomeStripProps) {
  const { ally, enemy } = view.defeatedFormations;
  return (
    <div className={styles["strip"]}>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>OUTCOME</span>
        <div className={`${styles["value"]} ${styles["outcomeValue"]}`}>{view.outcomeLabel}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>COMPLETION REASON</span>
        <div className={styles["value"]}>{view.completionReasonLabel}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>COMPLETED TURN</span>
        <div className={`${styles["value"]} ${styles["mono"]}`}>
          {`${String(view.completedTurn)} / ${String(view.turnLimit)}`}
        </div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>撃破された編成</span>
        <div className={styles["formationCounts"]}>
          <span aria-label="味方 撃破された編成">
            <span className={styles["allyText"]}>味方</span>
            <span
              className={styles["mono"]}
            >{` ${String(ally.defeated)} / ${String(ally.total)}`}</span>
          </span>
          <span aria-label="敵 撃破された編成">
            <span className={styles["enemyText"]}>敵</span>
            <span
              className={styles["mono"]}
            >{` ${String(enemy.defeated)} / ${String(enemy.total)}`}</span>
          </span>
        </div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>BATTLE ID</span>
        <div className={`${styles["value"]} ${styles["mono"]}`}>{view.battleId}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>CATALOG REVISION</span>
        <div className={`${styles["value"]} ${styles["mono"]}`}>{view.catalogRevision}</div>
      </div>
    </div>
  );
}
