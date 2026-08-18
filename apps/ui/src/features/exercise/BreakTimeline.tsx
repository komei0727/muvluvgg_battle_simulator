import { useId } from "react";
import type { ExerciseBreakRow } from "./exercise-result-projector.js";
import styles from "./BreakTimeline.module.css";

export interface BreakTimelineProps {
  /** `selectExerciseResultView`が発生順に並べた行。 */
  readonly breaks: readonly ExerciseBreakRow[];
}

// docs/ui-design/01_UI要求・画面設計.md `UI-UC-006` step 4 / `UI-CMP-012`:
// ブレイク番号・発生ターン・その時点の累計スコア・発生源を発生順に出す。0回でも
// 「起きなかった」ことを明示し、表示自体は成立させる（`UI-AC-021`）。
export function BreakTimeline({ breaks }: BreakTimelineProps) {
  const headingId = useId();
  return (
    <section className={styles["section"]} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles["header"]}>
        BREAK TIMELINE / ブレイク履歴
      </h3>
      {breaks.length === 0 ? (
        <p className={styles["empty"]}>ブレイクは発生しませんでした。</p>
      ) : (
        <div className={styles["scrollArea"]}>
          <table className={styles["table"]}>
            <thead>
              <tr>
                <th scope="col">BREAK</th>
                <th scope="col">TURN</th>
                <th scope="col">累計スコア</th>
                <th scope="col">発生源</th>
              </tr>
            </thead>
            <tbody>
              {breaks.map((row) => (
                <tr key={row.breakNumber}>
                  <td className={styles["mono"]}>{row.breakNumber}</td>
                  <td className={styles["mono"]}>{row.turnNumber}</td>
                  <td className={styles["mono"]}>{row.cumulativeScoreAtBreak.toLocaleString()}</td>
                  <td className={styles["source"]}>{row.sourceLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
