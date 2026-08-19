import { describe, expect, it } from "vitest";
import {
  DEFAULT_BEST_OF,
  MIN_RELIABLE_EFFECTIVE_SAMPLES,
  bestQuantile,
  buildDailyBestDistribution,
  effectiveSamples,
  expectedBest,
  isReliable,
  summarizeDailyBest,
} from "./daily-best.js";
import { PYTHON_PARITY } from "./__fixtures__/python-parity.js";
import { expectNumericParity } from "./test-parity.js";

const CASE_NAMES = PYTHON_PARITY.cases.map((entry) => entry.name);

function findCase(name: string): (typeof PYTHON_PARITY.cases)[number] {
  const found = PYTHON_PARITY.cases.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`fixture case ${name} が無い`);
  }
  return found;
}

// UI-UT-STS-007: スコアアタックは1日k回挑戦してベストで競うため、主役の指標は平均
// ではなく E[best-of-k]。定義の正本は `optimize/fitness.py:expected_best`。
describe("expectedBest (UI-UT-STS-007)", () => {
  it.each(CASE_NAMES)("matches the exercise-lab expected daily best for the %s sample", (name) => {
    const fixture = findCase(name);

    expectNumericParity(
      expectedBest(fixture.scores, DEFAULT_BEST_OF),
      fixture.dailyBest.expectedBest,
    );
  });

  it("falls back to the sample maximum when fewer runs than the daily attempts finished", () => {
    // 復元なしにk個引けない以上この推定量は定義できない。部分結果でも順位付けの
    // 入力として壊れないよう最大値へ落とす（`fitness.expected_best`と同じ）。
    expect(expectedBest([41_200, 39_500, 44_100], 5)).toBe(44_100);
  });

  it("returns the tied value when every run scored the same", () => {
    // 重みを比の積で持つため、和は厳密整数にはならない（Python実装は厳密な整数で
    // 二項係数を作る）。差は標本数に比例した数ulpに収まる。
    expectNumericParity(expectedBest([37_000, 37_000, 37_000, 37_000, 37_000, 37_000], 5), 37_000);
  });

  it("weights only the top order statistics", () => {
    // k=2、n=3 なら E[best-of-2] = (0·x₁ + 1·x₂ + 2·x₃)/C(3,2)。
    expect(expectedBest([10, 20, 30], 2)).toBeCloseTo((20 + 2 * 30) / 3, 12);
  });

  it("rejects an empty sample and a daily attempt count below one", () => {
    expect(() => expectedBest([], DEFAULT_BEST_OF)).toThrow();
    expect(() => expectedBest([1, 2], 0)).toThrow();
  });
});

// UI-UT-STS-008: 日次ベストの分位点は閉形式で1試行分布へ写る。
// P(日次ベスト ≤ x) = F(x)^k より、日次ベストのq分位点 = 1試行スコアの q^(1/k) 分位点。
describe("bestQuantile (UI-UT-STS-008)", () => {
  it.each(CASE_NAMES)("matches the exercise-lab guarantee lines for the %s sample", (name) => {
    const fixture = findCase(name);

    for (const expected of fixture.dailyBest.quantiles) {
      expectNumericParity(
        bestQuantile(fixture.scores, DEFAULT_BEST_OF, expected.quantile),
        expected.value,
      );
    }
  });

  it("reads the guarantee line off the single-run distribution at q^(1/k)", () => {
    const scores = [10, 20, 30, 40, 50];

    // q=0.25、k=2 なら level=0.5、位置 = 0.5·(5−1) = 2 → 30。
    expect(bestQuantile(scores, 2, 0.25)).toBeCloseTo(30, 12);
  });

  it("rejects a quantile outside the open unit interval", () => {
    expect(() => bestQuantile([1, 2], DEFAULT_BEST_OF, 0)).toThrow();
    expect(() => bestQuantile([1, 2], DEFAULT_BEST_OF, 1)).toThrow();
  });
});

// UI-UT-STS-009: 重みが上位の標本へ集中するため、実効サンプル数は n ではなく
// およそ n(2k−1)/k²（k=5 で n の36%）。これを下回る値は報告に使えない。
describe("effectiveSamples (UI-UT-STS-009)", () => {
  it.each(CASE_NAMES)(
    "matches the exercise-lab effective sample size for the %s sample",
    (name) => {
      const fixture = findCase(name);

      expectNumericParity(
        effectiveSamples(fixture.scores.length, DEFAULT_BEST_OF),
        fixture.dailyBest.effectiveSamples,
      );
      expect(isReliable(fixture.scores.length, DEFAULT_BEST_OF)).toBe(fixture.dailyBest.reliable);
    },
  );

  it("treats the exercise-lab threshold as the reliability boundary", () => {
    expect(MIN_RELIABLE_EFFECTIVE_SAMPLES).toBe(PYTHON_PARITY.minReliableEffectiveSamples);
    // k=5 では n·9/25 ≧ 10 ⇔ n ≧ 27.7…。
    expect(isReliable(27, DEFAULT_BEST_OF)).toBe(false);
    expect(isReliable(28, DEFAULT_BEST_OF)).toBe(true);
  });
});

// UI-UT-STS-010: 日次ベストの分布はチャートで単発分布と重ねる。経験CDFから
// F(x)^k を引くだけなので、標本の外へ外挿しない。
describe("buildDailyBestDistribution (UI-UT-STS-010)", () => {
  it("raises the empirical CDF to the k-th power at each distinct score", () => {
    const curve = buildDailyBestDistribution([10, 20, 20, 30], 2);

    expect(curve).toEqual([
      { score: 10, singleRunCdf: 0.25, dailyBestCdf: 0.0625 },
      { score: 20, singleRunCdf: 0.75, dailyBestCdf: 0.5625 },
      { score: 30, singleRunCdf: 1, dailyBestCdf: 1 },
    ]);
  });

  it("collapses a tied sample into one point that both curves reach", () => {
    expect(buildDailyBestDistribution([37_000, 37_000], DEFAULT_BEST_OF)).toEqual([
      { score: 37_000, singleRunCdf: 1, dailyBestCdf: 1 },
    ]);
  });
});

// UI-UT-STS-008/009: 表示側が引き回す1組。保証ラインの向きは「悪い日でもこれ以上」
// なので、下側分位点ほど低い値になる。
describe("summarizeDailyBest", () => {
  it("bundles the expected best, the guarantee lines and the reliability verdict", () => {
    const fixture = findCase("main");

    const summary = summarizeDailyBest(fixture.scores, DEFAULT_BEST_OF);

    expect(summary.bestOf).toBe(5);
    expect(summary.runs).toBe(fixture.scores.length);
    expectNumericParity(summary.expectedBest, fixture.dailyBest.expectedBest);
    expectNumericParity(summary.effectiveSamples, fixture.dailyBest.effectiveSamples);
    expect(summary.reliable).toBe(fixture.dailyBest.reliable);
    for (const expected of fixture.dailyBest.quantiles) {
      const line = { 0.25: summary.guaranteed75, 0.1: summary.guaranteed90, 0.5: summary.median }[
        expected.quantile
      ];
      expectNumericParity(line ?? Number.NaN, expected.value);
    }
    expect(summary.guaranteed90).toBeLessThan(summary.guaranteed75);
    expect(summary.guaranteed75).toBeLessThan(summary.median);
  });
});
