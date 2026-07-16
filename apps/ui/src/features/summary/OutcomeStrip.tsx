import type { BattleResultResponse } from "../simulation/api-contract.js";
import styles from "./OutcomeStrip.module.css";

export interface OutcomeStripProps {
  readonly result: BattleResultResponse;
  readonly turnLimit: number;
  readonly battleId: string;
  readonly catalogRevision: string;
}

// docs/ui-design/01_UI要求・画面設計.md §7.1: 未知の列挙値はコードをそのまま
// 表示し、画面全体を失敗させない。
const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  ALLY_WIN: "ALLY WIN / 味方勝利",
  ALLY_LOSE: "ALLY LOSE / 味方敗北",
};

const COMPLETION_REASON_LABELS: Readonly<Record<string, string>> = {
  ENEMY_DEFEATED: "敵陣営全滅",
  ALLY_DEFEATED: "味方陣営全滅",
  SIMULTANEOUS_DEFEAT: "同時全滅",
  TURN_LIMIT_REACHED: "ターン上限到達",
};

export function OutcomeStrip({ result, turnLimit, battleId, catalogRevision }: OutcomeStripProps) {
  const outcomeLabel = OUTCOME_LABELS[result.outcome] ?? result.outcome;
  const completionReasonLabel =
    COMPLETION_REASON_LABELS[result.completionReason] ?? result.completionReason;

  return (
    <div className={styles["strip"]}>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>OUTCOME</span>
        <div className={`${styles["value"]} ${styles["outcomeValue"]}`}>{outcomeLabel}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>COMPLETION REASON</span>
        <div className={styles["value"]}>{completionReasonLabel}</div>
      </div>
      <div className={styles["cell"]}>
        <span className={styles["label"]}>COMPLETED TURN</span>
        <div className={`${styles["value"]} ${styles["mono"]}`}>
          {result.completedTurn} / {turnLimit}
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
