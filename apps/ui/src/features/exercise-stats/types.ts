/**
 * 統計実行が集めた試行ごとの生値。評価API（`10_API設計.md`
 * 「TacticalExerciseEvaluationRunResponse」）の試行レコードを`evaluation-chunk-plan.ts`が
 * 並べ直したもので、6つの配列は同じ試行を同じ添字で指す。`allyUnit*`の内側は味方枠の
 * `unitIndex`順（リクエストの`allyFormation.units`と同じ長さ・同じ順）である。
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
