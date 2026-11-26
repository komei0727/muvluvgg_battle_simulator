// 統計実行の結果を持ち出す2つの形。この module が公開出力の契約の正本である。
// 生データCSVは先頭7列の名前と並びを固定する —— 後段の分析スクリプトが列位置を前提に
// 読めるようにするためである。ユニット別の列は後ろへ足す。
//
// `run_index`は評価APIの通し試行番号であり、`seed`・`catalogRevision`・`engineRevision`・
// `seedDerivationVersion`と組で試行を再現する。旧契約（`<seed>#<runOffset>`をチャンクごとに
// 送っていた頃）のCSVは`chunk_seed`・`run_index_in_chunk`列を持ち、同じseed文字列でも別の
// 乱数列の試行である。列名の違いで新旧を見分け、両者を同じ試行として突き合わせない。

import type { ScoreStatisticsReport, UnitStatisticsReport } from "./statistics-report.js";
import type { AllyUnitLabel } from "./statistics-report.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";

/** 生データCSVの先頭7列。並びを変えない（後段が列位置を前提に読む）。 */
const BASE_RUN_COLUMNS = [
  "run_index",
  "seed",
  "chunk_index",
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
 * —— 埋めると後段が「0点で終わった試行」と「走らなかった試行」を区別できない。期限までに
 * 終わらなかった試行番号は詰めずに抜けたままにする（統計サマリJSONの`incompleteRunIndices`）。
 *
 * ユニット別の列は編成順の1始まりで、`unit_<n>_damage` が先に全列、続いて
 * `unit_<n>_break_count` が全列並ぶ。定義IDを列名に使わないのは、同じ定義を複数の枠へ
 * 置けて列名が衝突するためである。列と定義IDの対応は統計サマリJSONの`units`が持つ。
 */
export function buildRunsCsv(
  aggregate: EvaluationAggregate,
  labels: readonly AllyUnitLabel[],
  seed: string,
): string {
  const { sample } = aggregate;
  const unitCount = sample.allyUnitDamageTotals[0]?.length ?? labels.length;
  const unitColumns = Array.from({ length: unitCount }, (_value, index) => index + 1);
  const header = [
    ...BASE_RUN_COLUMNS,
    ...unitColumns.map((column) => `unit_${column.toString()}_damage`),
    ...unitColumns.map((column) => `unit_${column.toString()}_break_count`),
  ].join(",");

  const rows = sample.scores.map((score, position) => {
    const provenance = aggregate.runs[position];
    const damage = sample.allyUnitDamageTotals[position] ?? [];
    const breaks = sample.allyUnitBreakCounts[position] ?? [];
    return [
      provenance?.runIndex ?? position,
      seed,
      provenance?.chunkIndex ?? 0,
      score,
      sample.breakCounts[position] ?? 0,
      sample.completedTurns[position] ?? 0,
      sample.completionReasons[position] ?? "",
      ...unitColumns.map((_column, index) => damage[index] ?? 0),
      ...unitColumns.map((_column, index) => breaks[index] ?? 0),
    ]
      .map(csvField)
      .join(",");
  });

  return [header, ...rows, ""].join("\n");
}

/**
 * 統計サマリのJSON。再現条件（seed・実行環境の識別情報・試行数）とスコア統計のキーを先に
 * 置き、日次ベスト指標とユニット別統計を足す。`engineRevision`・`seedDerivationVersion`を
 * 持つことが新契約（通し試行番号）の実行であることの印であり、旧契約のサマリは持たない。
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
      engineRevision: score.engineRevision,
      seedDerivationVersion: score.seedDerivationVersion,
      requestedRuns: score.requestedRuns,
      // 中断すると要求より小さくなる。要求・送信・完了は別物なので3つとも残す。
      sentRuns: score.sentRuns,
      completedRuns: score.completedRuns,
      partial: score.partial,
      // 送ったが期限までに完了しなかった試行番号。同じseedでこの番号だけを送り直せば補える。
      incompleteRunIndices: score.incompleteRunIndices,
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
