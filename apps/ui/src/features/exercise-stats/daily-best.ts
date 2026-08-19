// 日次ベスト指標。正本は `tools/exercise-lab/src/exercise_lab/optimize/fitness.py`。
//
// スコアアタックは1日k回挑戦でき、その日の成績は最大値で決まる。したがって見るべき値は
// 平均ではなく E[k回中のベスト] である。平均だと向きが2つ狂う——会心で伸びる上振れ
// （ベスト勝負では資産）が評価されず、稀な崩壊（k回中1回無駄になるだけ）を実際以上に
// 恐れることになる。

import { quantileOfSorted } from "./descriptive-statistics.js";

/** スコアアタックの1日の挑戦回数。`fitness.DEFAULT_BEST_OF` と同じ。 */
export const DEFAULT_BEST_OF = 5;

/**
 * 指標を数値として読んでよい実効サンプル数の下限。`fitness.MIN_RELIABLE_EFFECTIVE_SAMPLES`
 * と同じ。これを下回る試行数の値は上位数標本への依存が強い。
 */
export const MIN_RELIABLE_EFFECTIVE_SAMPLES = 10;

/** 「4日に3日はこれ以上出る」保証ライン。日次ベスト分布の下側25%点。 */
const GUARANTEED_75_QUANTILE = 0.25;

/** 「10日に9日はこれ以上出る」保証ライン。 */
const GUARANTEED_90_QUANTILE = 0.1;

export interface DailyBestSummary {
  readonly bestOf: number;
  readonly runs: number;
  readonly expectedBest: number;
  readonly guaranteed75: number;
  readonly guaranteed90: number;
  /** 日次ベストの中央値（k=5 なら1試行分布の約p87）。 */
  readonly median: number;
  readonly effectiveSamples: number;
  /** 実効サンプル数が下限に達しており、値そのものを読んでよいか。 */
  readonly reliable: boolean;
}

export interface DailyBestDistributionPoint {
  readonly score: number;
  readonly singleRunCdf: number;
  readonly dailyBestCdf: number;
}

/**
 * 期待日次ベスト（n標本からk個引いたときの最大値の期待値、不偏）。
 *
 * n標本からランダムにk個引いたときの最大値が昇順i番目になる確率は C(i−1, k−1)/C(n, k)
 * なので、E[best-of-k] = Σ_i C(i−1, k−1)/C(n, k)·x_(i)。二項係数そのものは n=2,000 で
 * 倍精度の整数域を超えるため、重みの比 w_i = w_(i−1)·i/(i−k+1) を積んで求める。
 *
 * n < k の部分結果では標本の最大値へ落とす。復元なしにk個引けない以上この推定量は
 * 定義できず、最大値は低めに偏るが順位付けの入力としては壊れない。
 */
export function expectedBest(scores: readonly number[], bestOf: number): number {
  rejectInvalidBestOf(bestOf);
  const ordered = sortAscending(scores);
  const count = ordered.length;
  const maximum = ordered[count - 1] ?? 0;
  if (count < bestOf) {
    return maximum;
  }

  // w_(k−1) = C(k−1, k−1)/C(n, k) = 1/C(n, k)。C(n, k) を作らずに逆数を直接積むのは、
  // 分子分母のどちらも桁溢れさせないため。
  let weight = 1;
  for (let step = 1; step <= bestOf; step += 1) {
    weight *= step / (count - bestOf + step);
  }

  // C(i−1, k−1) は i < k で0になるので、下位の標本は自然に重み0で消える。
  let total = 0;
  for (let index = bestOf - 1; index < count; index += 1) {
    if (index > bestOf - 1) {
      weight *= index / (index - bestOf + 1);
    }
    total += weight * (ordered[index] ?? 0);
  }
  return total;
}

/**
 * 日次ベストの q 分位点。P(日次ベスト ≤ x) = F(x)^k なので、1試行分布の q^(1/k) 分位点
 * として引ける（線形補間）。「悪い日でもこれ以上は出る」保証値として読む。
 */
export function bestQuantile(scores: readonly number[], bestOf: number, quantile: number): number {
  rejectInvalidBestOf(bestOf);
  if (!(quantile > 0 && quantile < 1)) {
    throw new Error(`quantile は0より大きく1未満でなければならない（${quantile}）`);
  }
  return quantileOfSorted(sortAscending(scores), quantile ** (1 / bestOf));
}

/**
 * この試行数が持つ実効サンプル数 ≈ n(2k−1)/k²（連続近似）。重みが上位2割前後へ集中
 * するため、n をそのまま信頼度として読むと過大評価になる。
 */
export function effectiveSamples(runs: number, bestOf: number): number {
  rejectInvalidBestOf(bestOf);
  return (runs * (2 * bestOf - 1)) / bestOf ** 2;
}

/** この試行数の日次ベスト指標を数値として報告してよいか。 */
export function isReliable(runs: number, bestOf: number): boolean {
  return effectiveSamples(runs, bestOf) >= MIN_RELIABLE_EFFECTIVE_SAMPLES;
}

export function summarizeDailyBest(
  scores: readonly number[],
  bestOf: number = DEFAULT_BEST_OF,
): DailyBestSummary {
  return {
    bestOf,
    runs: scores.length,
    expectedBest: expectedBest(scores, bestOf),
    guaranteed75: bestQuantile(scores, bestOf, GUARANTEED_75_QUANTILE),
    guaranteed90: bestQuantile(scores, bestOf, GUARANTEED_90_QUANTILE),
    median: bestQuantile(scores, bestOf, 0.5),
    effectiveSamples: effectiveSamples(scores.length, bestOf),
    reliable: isReliable(scores.length, bestOf),
  };
}

/**
 * 単発分布と日次ベスト分布を重ねるための点列。経験CDF F(x) と F(x)^k を、標本に実際に
 * 現れたスコアの昇順で返す——標本の外へ外挿すると、試行していない領域の曲線を描く。
 */
export function buildDailyBestDistribution(
  scores: readonly number[],
  bestOf: number = DEFAULT_BEST_OF,
): readonly DailyBestDistributionPoint[] {
  rejectInvalidBestOf(bestOf);
  const ordered = sortAscending(scores);
  const points: DailyBestDistributionPoint[] = [];
  for (const [index, score] of ordered.entries()) {
    if (ordered[index + 1] === score) {
      continue;
    }
    const singleRunCdf = (index + 1) / ordered.length;
    points.push({ score, singleRunCdf, dailyBestCdf: singleRunCdf ** bestOf });
  }
  return points;
}

function sortAscending(scores: readonly number[]): readonly number[] {
  if (scores.length === 0) {
    throw new Error("日次ベスト指標を出すには1件以上のスコアが要る");
  }
  return [...scores].sort((left, right) => left - right);
}

function rejectInvalidBestOf(bestOf: number): void {
  if (bestOf < 1) {
    throw new Error(`bestOf は1以上でなければならない（${bestOf}）`);
  }
}
