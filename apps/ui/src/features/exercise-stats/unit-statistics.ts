// キャラ別の集計と、ベストスコア上位N試行の部分集計。exercise-lab はユニット単位の
// 生値（`allyUnitDamageTotals` / `allyUnitBreakCounts`、Issue #537）を読まないため、
// この2つの統計はUI側だけが持つ。分位点の定義だけは一般統計と共有する。

import { quantileOfSorted } from "./descriptive-statistics.js";
import type { ExerciseStatisticsSample } from "./types.js";

/**
 * 1つのユニット列の散らばり。与ダメージとブレイク回数で同じ形にするのは、どちらも
 * 「試行ごとにこの枠がどれだけ働いたか」の分布であり、同じ図（共通スケールの分布バー）
 * で読ませるためである。
 */
export interface AllyUnitColumnDistribution {
  /** 編成順の列番号。表示名の解決は呼び出し側（Catalog）が持つ。 */
  readonly unitIndex: number;
  readonly mean: number;
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface AllyUnitDamageSummary extends AllyUnitColumnDistribution {
  /** 平均の合計に対する割合。試行ごとの割合の平均ではない。 */
  readonly contribution: number;
}

export interface AllyUnitBreakSummary extends AllyUnitColumnDistribution {
  /**
   * この枠が1回もブレイクを起こさなかった試行の割合。分位点だけでは読めない
   * ——ブレイク回数の共通スケールは20回以上取る枠に合わせて伸びるため、数回しか
   * 取らない枠の箱は潰れて0との差が見えなくなる。
   */
  readonly zeroBreakRatio: number;
}

export interface AllyUnitBreakStatistics {
  readonly units: readonly AllyUnitBreakSummary[];
  /**
   * 味方の枠が起こしたのではないブレイクの平均回数。`10_API設計.md`
   * 「TacticalExerciseCandidateEvaluationResponse」のとおり、ここには発生源ユニットを
   * 持たないブレイク（メモリー由来の継続ダメージ、`R-MEM-04`）と、敵の枠自身が起こした
   * ブレイク（混乱による自傷など、`R-CFS-01`）の両方が入る。起源を一つに断定できない。
   */
  readonly unattributedBreakMean: number;
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

/** 1列分の散らばり。分位点の定義は一般統計（`quantileOfSorted`）と共有する。 */
function summarizeColumn(values: readonly number[], unitIndex: number): AllyUnitColumnDistribution {
  const ordered = [...values].sort((left, right) => left - right);
  return {
    unitIndex,
    mean: mean(values),
    median: quantileOfSorted(ordered, 0.5),
    p25: quantileOfSorted(ordered, 0.25),
    p75: quantileOfSorted(ordered, 0.75),
    minimum: ordered[0] ?? 0,
    maximum: ordered.at(-1) ?? 0,
  };
}

export function summarizeAllyUnitDamage(
  allyUnitDamageTotals: readonly (readonly number[])[],
): readonly AllyUnitDamageSummary[] {
  const columns = readColumns(allyUnitDamageTotals, "ユニット別与ダメージ");
  const distributions = columns.map(summarizeColumn);
  const totalMean = distributions.reduce((total, column) => total + column.mean, 0);

  return distributions.map((column) => ({
    ...column,
    // 全ユニットが0ダメージの試行だけが集まると分母が0になる。寄与率を出せない
    // ことと「寄与していない」ことは同じなので0にする。
    contribution: totalMean === 0 ? 0 : column.mean / totalMean,
  }));
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
      ...summarizeColumn(values, unitIndex),
      zeroBreakRatio: values.filter((value) => value === 0).length / values.length,
    })),
    unattributedBreakMean: mean(residuals),
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
  // 上位N選抜はスコアの添字で行うため、ユニット別の行が足りないと、その試行が
  // 全ユニット0として平均へ入る。列数不一致を拒否しているのと同じ理由で、静かに
  // 過少な平均を出すより契約違反として落とす。
  if (
    sample.allyUnitDamageTotals.length !== sample.scores.length ||
    sample.allyUnitBreakCounts.length !== sample.scores.length
  ) {
    throw new Error("ユニット別の生値はスコアと同じ試行数でなければならない");
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
