// Mirrors docs/ui-design/01_UI要求・画面設計.md `UI-UC-006` step 4 と
// 04_コンポーネント・状態管理設計.md `UI-CMP-012`: 演習結果の表示値をpure function
// として導出し、componentはこの投影だけを描画する（`UI-CMP-005`）。

import { EXERCISE_TURN_LIMIT } from "./exercise-draft-validation.js";
import type { ExerciseResultResponse } from "../simulation/api-contract.js";

export interface ExerciseBreakRow {
  readonly breakNumber: number;
  readonly turnNumber: number;
  readonly cumulativeScoreAtBreak: number;
}

export interface ExerciseResultView {
  readonly totalScore: number;
  readonly breakCount: number;
  readonly completionReasonLabel: string;
  readonly completedTurn: number;
  readonly turnLimit: number;
  /** 発生順（ブレイク番号の昇順）。ブレイク0回では空配列。 */
  readonly breaks: readonly ExerciseBreakRow[];
}

// docs/ddd/10_API設計.md「ExerciseResultResponse」: 演習の終了理由はこの2値だが、
// 未知の列挙値はコードのまま見せて画面を壊さない（`UI-AC-011`と同じ方針）。
const COMPLETION_REASON_LABELS: Readonly<Record<string, string>> = {
  TURN_LIMIT_REACHED: "ターン上限到達",
  ALLY_DEFEATED: "味方陣営全滅",
};

/** `SubmissionFeedback`の1行要約。演習は勝敗を持たないためスコアで代替する。 */
export function describeExerciseResult(result: ExerciseResultResponse): string {
  const view = selectExerciseResultView(result);
  return `スコア ${view.totalScore.toLocaleString()} / ブレイク ${view.breakCount}回 / ${view.completionReasonLabel} (turn ${view.completedTurn})`;
}

export function selectExerciseResultView(result: ExerciseResultResponse): ExerciseResultView {
  return {
    totalScore: result.totalScore,
    breakCount: result.breakCount,
    completionReasonLabel:
      COMPLETION_REASON_LABELS[result.completionReason] ?? result.completionReason,
    completedTurn: result.completedTurn,
    turnLimit: EXERCISE_TURN_LIMIT,
    breaks: result.breaks
      .map((entry) => ({
        breakNumber: entry.breakNumber,
        turnNumber: entry.turnNumber,
        cumulativeScoreAtBreak: entry.cumulativeScoreAtBreak,
      }))
      .toSorted((a, b) => a.breakNumber - b.breakNumber),
  };
}
