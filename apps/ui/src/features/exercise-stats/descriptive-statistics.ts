// 統計の定義の正本は `tools/exercise-lab/src/exercise_lab/stats.py` であり、この
// module はその移植である。サーバーは統計量を返さない（`10_API設計.md`
// 「TacticalExerciseCandidateEvaluationResponse」、Q-TEX-16）ため、統計実行の集計は
// すべてここを通る。Python実装との数値一致は `__fixtures__/python-parity.ts` が押さえる。

/** 平均の信頼区間の水準。`stats.py` と同じく正規近似で出す。 */
export const CONFIDENCE_LEVEL = 0.95;

/** 標準正規分布の97.5%点。`stats.py:NORMAL_QUANTILE_95` と同じ定数。 */
export const NORMAL_QUANTILE_95 = 1.959963984540054;

export const ALLY_DEFEATED = "ALLY_DEFEATED";

/** ヒストグラムのビン数の下限・上限。試行数が極端でも図が読める幅に留める。 */
const MIN_HISTOGRAM_BINS = 1;
const MAX_HISTOGRAM_BINS = 60;

export interface ScoreSummary {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  /** 試行1回では散らばりが定義できないため`null`。0は「ばらつきが無い」という別の意味。 */
  readonly stdev: number | null;
  readonly minimum: number;
  readonly maximum: number;
  readonly p05: number;
  readonly p25: number;
  readonly p75: number;
  readonly p95: number;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;
}

export interface CompletionReasonShare {
  readonly completionReason: string;
  readonly runs: number;
  readonly ratio: number;
}

export interface CompletionReasonSummary {
  /** `ALLY_DEFEATED`で終わった試行の割合。5ターン走り切れない編成を弾く指標。 */
  readonly defeatRate: number;
  /** 試行数の降順。同数は終了理由の昇順で、標本の並びに依存させない。 */
  readonly breakdown: readonly CompletionReasonShare[];
}

export interface BreakCountShare {
  readonly breakCount: number;
  readonly runs: number;
}

export interface BreakCountSummary {
  readonly mean: number;
  /** 回数の昇順。表示側の並べ替えに依存させない。 */
  readonly distribution: readonly BreakCountShare[];
}

export interface HistogramBin {
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly runs: number;
}

/**
 * 昇順に並べた標本の線形補間分位点。`numpy.percentile` の既定（`method="linear"`）
 * と同じ位置づけで、`fitness.best_quantile` もこの補間を使う。
 */
export function quantileOfSorted(ordered: readonly number[], probability: number): number {
  const last = ordered.at(-1);
  if (last === undefined) {
    throw new Error("分位点を出すには1件以上の値が要る");
  }
  const position = probability * (ordered.length - 1);
  const low = Math.floor(position);
  const next = ordered[low + 1];
  if (next === undefined) {
    return last;
  }
  const lowValue = ordered[low] ?? last;
  return lowValue + (position - low) * (next - lowValue);
}

export function summarizeScores(scores: readonly number[]): ScoreSummary {
  if (scores.length === 0) {
    throw new Error("統計を出すには1件以上のスコアが要る");
  }
  const ordered = [...scores].sort((left, right) => left - right);
  const count = ordered.length;
  const mean = ordered.reduce((total, score) => total + score, 0) / count;
  // 標本標準偏差（ddof=1）。1件では分母が0になるため定義しない。
  const stdev =
    count < 2
      ? null
      : Math.sqrt(ordered.reduce((total, score) => total + (score - mean) ** 2, 0) / (count - 1));
  const halfWidth = stdev === null ? null : (NORMAL_QUANTILE_95 * stdev) / Math.sqrt(count);

  return {
    count,
    mean,
    median: quantileOfSorted(ordered, 0.5),
    stdev,
    minimum: ordered[0] ?? mean,
    maximum: ordered.at(-1) ?? mean,
    p05: quantileOfSorted(ordered, 0.05),
    p25: quantileOfSorted(ordered, 0.25),
    p75: quantileOfSorted(ordered, 0.75),
    p95: quantileOfSorted(ordered, 0.95),
    ciLow: halfWidth === null ? null : mean - halfWidth,
    ciHigh: halfWidth === null ? null : mean + halfWidth,
  };
}

export function summarizeCompletionReasons(
  completionReasons: readonly string[],
): CompletionReasonSummary {
  if (completionReasons.length === 0) {
    throw new Error("終了理由の内訳を出すには1件以上の完了理由が要る");
  }
  const runsByReason = new Map<string, number>();
  for (const reason of completionReasons) {
    runsByReason.set(reason, (runsByReason.get(reason) ?? 0) + 1);
  }
  const breakdown = [...runsByReason.entries()]
    .map(([completionReason, runs]) => ({
      completionReason,
      runs,
      ratio: runs / completionReasons.length,
    }))
    .sort(
      (left, right) =>
        right.runs - left.runs || left.completionReason.localeCompare(right.completionReason),
    );

  return {
    defeatRate: (runsByReason.get(ALLY_DEFEATED) ?? 0) / completionReasons.length,
    breakdown,
  };
}

export function summarizeBreakCounts(breakCounts: readonly number[]): BreakCountSummary {
  if (breakCounts.length === 0) {
    throw new Error("ブレイク回数分布を出すには1件以上の試行が要る");
  }
  const runsByCount = new Map<number, number>();
  for (const breakCount of breakCounts) {
    runsByCount.set(breakCount, (runsByCount.get(breakCount) ?? 0) + 1);
  }

  return {
    mean: breakCounts.reduce((total, breakCount) => total + breakCount, 0) / breakCounts.length,
    distribution: [...runsByCount.entries()]
      .map(([breakCount, runs]) => ({ breakCount, runs }))
      .sort((left, right) => left.breakCount - right.breakCount),
  };
}

/**
 * 試行数からビン数を決める（Sturges）。試行数だけで決まるので、同じ入力なら同じ図に
 * なる（`stats.py:_histogram_bins`）。
 */
export function histogramBinCount(runs: number): number {
  if (runs <= 0) {
    return MIN_HISTOGRAM_BINS;
  }
  return Math.max(MIN_HISTOGRAM_BINS, Math.min(MAX_HISTOGRAM_BINS, Math.ceil(Math.log2(runs) + 1)));
}

/**
 * 等幅ビンへ試行を振る。最上位のビンだけ右端を含める（そうしないと最大スコアの試行が
 * どのビンにも入らない）。
 */
export function buildScoreHistogram(scores: readonly number[]): readonly HistogramBin[] {
  if (scores.length === 0) {
    throw new Error("ヒストグラムを出すには1件以上のスコアが要る");
  }
  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  // 全試行が同値だと幅0のビンしか作れない。等幅に割ると全ビンが同じ境界になり
  // 読めないので、1本の縮退したビンとして返す。
  if (minimum === maximum) {
    return [{ lowerBound: minimum, upperBound: maximum, runs: scores.length }];
  }

  const binCount = histogramBinCount(scores.length);
  const width = (maximum - minimum) / binCount;
  const runsPerBin = new Array<number>(binCount).fill(0);
  for (const score of scores) {
    const index = Math.min(binCount - 1, Math.floor((score - minimum) / width));
    runsPerBin[index] = (runsPerBin[index] ?? 0) + 1;
  }

  return runsPerBin.map((runs, index) => ({
    lowerBound: minimum + width * index,
    upperBound: index === binCount - 1 ? maximum : minimum + width * (index + 1),
    runs,
  }));
}
