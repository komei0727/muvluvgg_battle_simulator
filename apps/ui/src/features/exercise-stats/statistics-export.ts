// 統計実行の結果を持ち出す2つの形。この module が公開出力の契約の正本である。
// 生データCSVは先頭8列の名前と並びを固定する —— 後段の分析スクリプトが列位置を前提に
// 読めるようにするためで、旧 `tools/exercise-lab` の `runs.csv` と同じ並びにしてある
// （既存の分析資産を読み替えずに使えるよう、並びを変えない）。ユニット別の列は後ろへ足す。

import type { ScoreStatisticsReport, UnitStatisticsReport } from "./statistics-report.js";
import type { AllyUnitLabel } from "./statistics-report.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";

/** 生データCSVの先頭8列。並びを変えない（後段が列位置を前提に読む）。 */
const BASE_RUN_COLUMNS = [
  "run_index",
  "chunk_index",
  "chunk_seed",
  "run_index_in_chunk",
  "score",
  "break_count",
  "completed_turn",
  "completion_reason",
] as const;

/**
 * RFC 4180 のquoting。区切り・引用符・改行を含む値だけを囲む。seedは利用者が
 * 入力した任意文字列なので、囲まずに書くと列がずれる。
 */
function csvField(value: string | number): string {
  const text = typeof value === "number" ? value.toString() : value;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * 試行ごとの生値のCSV。行数は実際に完了した試行数であり、要求数まで空行を足さない
 * —— 埋めると後段が「0点で終わった試行」と「走らなかった試行」を区別できない。
 *
 * ユニット別の列は編成順の1始まりで、`unit_<n>_damage` が先に全列、続いて
 * `unit_<n>_break_count` が全列並ぶ。定義IDを列名に使わないのは、同じ定義を複数の枠へ
 * 置けて列名が衝突するためである。列と定義IDの対応は統計サマリJSONの`units`が持つ。
 */
export function buildRunsCsv(
  aggregate: EvaluationAggregate,
  labels: readonly AllyUnitLabel[],
): string {
  const { sample } = aggregate;
  const unitCount = sample.allyUnitDamageTotals[0]?.length ?? labels.length;
  const unitColumns = Array.from({ length: unitCount }, (_value, index) => index + 1);
  const header = [
    ...BASE_RUN_COLUMNS,
    ...unitColumns.map((column) => `unit_${column.toString()}_damage`),
    ...unitColumns.map((column) => `unit_${column.toString()}_break_count`),
  ].join(",");

  const rows = sample.scores.map((score, runIndex) => {
    const provenance = aggregate.runs[runIndex];
    const damage = sample.allyUnitDamageTotals[runIndex] ?? [];
    const breaks = sample.allyUnitBreakCounts[runIndex] ?? [];
    return [
      runIndex,
      provenance?.chunkIndex ?? 0,
      provenance?.chunkSeed ?? "",
      provenance?.runIndexInChunk ?? runIndex,
      score,
      sample.breakCounts[runIndex] ?? 0,
      sample.completedTurns[runIndex] ?? 0,
      sample.completionReasons[runIndex] ?? "",
      ...unitColumns.map((_column, index) => damage[index] ?? 0),
      ...unitColumns.map((_column, index) => breaks[index] ?? 0),
    ]
      .map(csvField)
      .join(",");
  });

  return [header, ...rows, ""].join("\n");
}

/**
 * 統計サマリのJSON。再現条件（seed・チャンクサイズ・試行数）とスコア統計のキーを先に置き、
 * 日次ベスト指標とユニット別統計を足す。先頭のキーは旧 `tools/exercise-lab` の
 * `summary.json` と同じ名前・同じ形で、既存の分析資産をそのまま読めるよう変えない。
 * 同じ実行から常に同じ文字列が出るよう、集計順に依存する値を入れない。
 */
export function buildStatisticsSummaryJson(
  score: ScoreStatisticsReport,
  units: UnitStatisticsReport,
): string {
  return JSON.stringify(
    {
      seed: score.seed,
      chunkSize: score.chunkSize,
      catalogRevision: score.catalogRevision,
      requestedRuns: score.requestedRuns,
      // 中断すると要求より小さくなる。要求・送信・完了は別物なので3つとも残す。
      sentRuns: score.sentRuns,
      completedRuns: score.completedRuns,
      partial: score.partial,
      score: score.score,
      defeatRate: score.completionReasons.defeatRate,
      completionReasons: score.completionReasons.breakdown,
      // JSONのキーは文字列でなければならないため、回数を文字列化して昇順で並べる
      // （先頭のキーと同じく、旧`summary.json`と同じ形を保つ）。
      breakCountDistribution: Object.fromEntries(
        score.breaks.distribution.map((share) => [share.breakCount.toString(), share.runs]),
      ),
      breakCountMean: score.breaks.mean,
      dailyBest: score.dailyBest,
      topRuns: {
        requestedTopN: units.requestedTopN,
        runs: units.topRuns,
        meanScore: units.topMeanScore,
        meanScoreDelta: units.topMeanScoreDelta,
      },
      units: units.rows.map((row) => ({
        unitIndex: row.label.unitIndex,
        unitDefinitionId: row.label.unitDefinitionId,
        displayName: row.label.displayName,
        damage: row.damage,
        breaks: row.breaks,
        topMeanDamage: row.topMeanDamage,
        topMeanBreakCount: row.topMeanBreakCount,
      })),
      unattributedBreakMean: units.unattributedBreakMean,
    },
    null,
    2,
  );
}
