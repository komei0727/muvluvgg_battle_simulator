import type { TotalWarStageRow } from "./total-war-result-projector.js";
import styles from "./StageHistoryTable.module.css";

export interface StageHistoryTableProps {
  readonly stages: readonly TotalWarStageRow[];
}

// docs/ui-design/01_UI要求・画面設計.md §7.5「戦闘履歴」（UI-AC-062）: `result.stages`を
// 発生順に1行ずつ出す。
export function StageHistoryTable({ stages }: StageHistoryTableProps) {
  return (
    <section className={styles["section"]}>
      <div className={styles["header"]}>
        <strong>BATTLE HISTORY / 戦闘履歴</strong>
      </div>
      <div className={styles["scrollArea"]}>
        <table className={styles["table"]} aria-label="戦闘履歴">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">組み合わせ</th>
              <th scope="col">ターン</th>
              <th scope="col">結果</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage) => (
              <tr key={stage.stageNumber}>
                <td className={styles["mono"]}>{stage.stageNumber}</td>
                <td>{stage.matchup}</td>
                <td className={styles["mono"]}>{stage.turns}</td>
                <td>{stage.resultLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
