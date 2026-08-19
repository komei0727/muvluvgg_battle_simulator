/**
 * 統計実行が集めた試行ごとの生値。評価API（`10_API設計.md`
 * 「TacticalExerciseCandidateEvaluationResponse」）の候補1件と同じ形で、6つの配列は
 * 同じ試行を同じ添字で指す。`allyUnit*`の内側はリクエストの`allyFormation.units`と
 * 同じ長さ・同じ順である。
 *
 * 期限到達で打ち切られた部分結果は配列が要求試行数より短くなるだけなので、統計は
 * `completedRuns`ではなく配列長から出す。
 */
export interface ExerciseStatisticsSample {
  readonly scores: readonly number[];
  readonly breakCounts: readonly number[];
  readonly completedTurns: readonly number[];
  readonly completionReasons: readonly string[];
  readonly allyUnitDamageTotals: readonly (readonly number[])[];
  readonly allyUnitBreakCounts: readonly (readonly number[])[];
}
