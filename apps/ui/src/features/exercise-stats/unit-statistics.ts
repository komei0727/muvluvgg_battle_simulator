// キャラ別の集計と、ベストスコア上位N試行の部分集計。exercise-lab はユニット単位の
// 生値（`allyUnitDamageTotals` / `allyUnitBreakCounts`、Issue #537）を読まないため、
// この2つの統計はUI側だけが持つ。分位点の定義だけは一般統計と共有する。

import { quantileOfSorted } from "./descriptive-statistics.js";
import type { ExerciseStatisticsSample } from "./types.js";

export interface AllyUnitDamageSummary {
  /** 編成順の列番号。表示名の解決は呼び出し側（Catalog）が持つ。 */
  readonly unitIndex: number;
  readonly mean: number;
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly minimum: number;
  readonly maximum: number;
  /** 平均の合計に対する割合。試行ごとの割合の平均ではない。 */
  readonly contribution: number;
}

export interface AllyUnitBreakRunShare {
  readonly none: number;
  readonly one: number;
  readonly two: number;
  readonly threeOrMore: number;
}

export interface AllyUnitBreakSummary {
  readonly unitIndex: number;
  readonly mean: number;
  readonly runsByBreakCount: AllyUnitBreakRunShare;
}

export interface AllyUnitBreakStatistics {
  readonly units: readonly AllyUnitBreakSummary[];
  /**
   * 味方ユニットが起こしたのではないブレイクの平均回数。メモリー由来の継続ダメージ
   * （R-MEM-04）のように発生源ユニットを持たないブレイクがここへ落ちる。
   */
  readonly memoryResidualMean: number;
}

export interface TopRunUnitSummary {
  readonly unitIndex: number;
  readonly meanDamage: number;
  /** 全体平均との差。正なら上位試行でこのユニットが平均以上に働いている。 */
  readonly meanDamageDelta: number;
  readonly meanBreakCount: number;
  readonly meanBreakCountDelta: number;
}

export interface TopRunSummary {
  /** 要求したN。試行数がNに満たないときも要求値のまま残し、`runs`と読み分ける。 */
  readonly requestedTopN: number;
  readonly runs: number;
  readonly meanScore: number;
  readonly meanScoreDelta: number;
  readonly units: readonly TopRunUnitSummary[];
}

export function summarizeAllyUnitDamage(
  allyUnitDamageTotals: readonly (readonly number[])[],
): readonly AllyUnitDamageSummary[] {
  const columns = readColumns(allyUnitDamageTotals, "ユニット別与ダメージ");
  const means = columns.map(mean);
  const totalMean = means.reduce((total, value) => total + value, 0);

  return columns.map((values, unitIndex) => {
    const ordered = [...values].sort((left, right) => left - right);
    return {
      unitIndex,
      mean: means[unitIndex] ?? 0,
      median: quantileOfSorted(ordered, 0.5),
      p25: quantileOfSorted(ordered, 0.25),
      p75: quantileOfSorted(ordered, 0.75),
      minimum: ordered[0] ?? 0,
      maximum: ordered.at(-1) ?? 0,
      // 全ユニットが0ダメージの試行だけが集まると分母が0になる。寄与率を出せない
      // ことと「寄与していない」ことは同じなので0にする。
      contribution: totalMean === 0 ? 0 : (means[unitIndex] ?? 0) / totalMean,
    };
  });
}

export function summarizeAllyUnitBreaks(
  allyUnitBreakCounts: readonly (readonly number[])[],
  breakCounts: readonly number[],
): AllyUnitBreakStatistics {
  const columns = readColumns(allyUnitBreakCounts, "ユニット別ブレイク回数");
  if (breakCounts.length !== allyUnitBreakCounts.length) {
    throw new Error("ブレイク回数とユニット別ブレイク回数は同じ試行数でなければならない");
  }

  const residuals = allyUnitBreakCounts.map(
    (row, runIndex) =>
      (breakCounts[runIndex] ?? 0) - row.reduce((total, value) => total + value, 0),
  );

  return {
    units: columns.map((values, unitIndex) => ({
      unitIndex,
      mean: mean(values),
      runsByBreakCount: {
        none: values.filter((value) => value === 0).length,
        one: values.filter((value) => value === 1).length,
        two: values.filter((value) => value === 2).length,
        threeOrMore: values.filter((value) => value >= 3).length,
      },
    })),
    memoryResidualMean: mean(residuals),
  };
}

/**
 * スコア降順の上位N試行だけを集めた部分集計。Nは引数なので、生値を持ったまま再計算
 * するだけで別のNへ切り替えられる。同点は試行の添字が小さい方を先に採り、標本の
 * 並びだけで結果が決まるようにする。
 */
export function summarizeTopRuns(sample: ExerciseStatisticsSample, topN: number): TopRunSummary {
  if (!Number.isInteger(topN) || topN < 1) {
    throw new Error(`上位N件のNは1以上の整数でなければならない（${topN}）`);
  }
  if (sample.scores.length === 0) {
    throw new Error("上位N件の集計を出すには1件以上の試行が要る");
  }

  const selected = sample.scores
    .map((score, runIndex) => ({ score, runIndex }))
    .sort((left, right) => right.score - left.score || left.runIndex - right.runIndex)
    .slice(0, topN)
    .map((entry) => entry.runIndex);

  const damage = summarizeAllyUnitDamage(sample.allyUnitDamageTotals);
  const breaks = summarizeAllyUnitBreaks(sample.allyUnitBreakCounts, sample.breakCounts);
  const meanScore = mean(selected.map((runIndex) => sample.scores[runIndex] ?? 0));

  return {
    requestedTopN: topN,
    runs: selected.length,
    meanScore,
    meanScoreDelta: meanScore - mean(sample.scores),
    units: damage.map((unit) => {
      const meanDamage = mean(
        selected.map((runIndex) => sample.allyUnitDamageTotals[runIndex]?.[unit.unitIndex] ?? 0),
      );
      const meanBreakCount = mean(
        selected.map((runIndex) => sample.allyUnitBreakCounts[runIndex]?.[unit.unitIndex] ?? 0),
      );
      return {
        unitIndex: unit.unitIndex,
        meanDamage,
        meanDamageDelta: meanDamage - unit.mean,
        meanBreakCount,
        meanBreakCountDelta: meanBreakCount - (breaks.units[unit.unitIndex]?.mean ?? 0),
      };
    }),
  };
}

/** 行（試行）×列（ユニット）を列ごとの配列へ転置する。 */
function readColumns(rows: readonly (readonly number[])[], label: string): readonly number[][] {
  const first = rows[0];
  if (first === undefined) {
    throw new Error(`${label}を出すには1件以上の試行が要る`);
  }
  const columns = first.map(() => [] as number[]);
  for (const row of rows) {
    if (row.length !== first.length) {
      // 列は編成の枠に対応する。試行ごとに幅が違うのは応答の契約違反であり、
      // 欠けた列を0で埋めると与ダメージを過少に見せる。
      throw new Error(`${label}は全試行で同じユニット数でなければならない`);
    }
    for (const [unitIndex, value] of row.entries()) {
      columns[unitIndex]?.push(value);
    }
  }
  return columns;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("平均を出すには1件以上の値が要る");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}
