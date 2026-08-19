import { describe, expect, it } from "vitest";
import {
  buildScoreHistogram,
  histogramBinCount,
  summarizeBreakCounts,
  quantileOfSorted,
  summarizeCompletionReasons,
  summarizeScores,
} from "./descriptive-statistics.js";
import { PYTHON_PARITY } from "./__fixtures__/python-parity.js";
import { expectNumericParity } from "./test-parity.js";

function findCase(name: string): (typeof PYTHON_PARITY.cases)[number] {
  const found = PYTHON_PARITY.cases.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`fixture case ${name} が無い`);
  }
  return found;
}

// UI-UT-STS-001: 統計の定義の正本は exercise-lab の `stats.py` であり、この移植が
// 黙って乖離しないことを、同じ標本に対する期待値の一致で示す。
describe("summarizeScores (UI-UT-STS-001)", () => {
  it.each(PYTHON_PARITY.cases.map((entry) => entry.name))(
    "matches the exercise-lab summary for the %s sample",
    (name) => {
      const fixture = findCase(name);

      const summary = summarizeScores(fixture.scores);

      expect(summary.count).toBe(fixture.summary.count);
      expect(summary.minimum).toBe(fixture.summary.minimum);
      expect(summary.maximum).toBe(fixture.summary.maximum);
      expectNumericParity(summary.mean, fixture.summary.mean);
      expectNumericParity(summary.median, fixture.summary.median);
      expectNumericParity(summary.p05, fixture.summary.p05);
      expectNumericParity(summary.p25, fixture.summary.p25);
      expectNumericParity(summary.p75, fixture.summary.p75);
      expectNumericParity(summary.p95, fixture.summary.p95);
      if (fixture.summary.stdev === null) {
        expect(summary.stdev).toBeNull();
        expect(summary.ciLow).toBeNull();
        expect(summary.ciHigh).toBeNull();
        return;
      }
      expectNumericParity(summary.stdev ?? Number.NaN, fixture.summary.stdev);
      expectNumericParity(summary.ciLow ?? Number.NaN, fixture.summary.ciLow ?? Number.NaN);
      expectNumericParity(summary.ciHigh ?? Number.NaN, fixture.summary.ciHigh ?? Number.NaN);
    },
  );
});

// UI-UT-STS-002: 試行1回では散らばりが定義できない。0を返すと「ばらつきが無い」と
// いう別の意味になるため`null`で区別する（`stats.py`の`ScoreSummary`と同じ）。
describe("summarizeScores の端点 (UI-UT-STS-002)", () => {
  it("reports no deviation and no interval for a single run", () => {
    const summary = summarizeScores([42_195]);

    expect(summary.stdev).toBeNull();
    expect(summary.ciLow).toBeNull();
    expect(summary.ciHigh).toBeNull();
    expect(summary.mean).toBe(42_195);
  });

  it("keeps a zero deviation distinct from an undefined one when every run ties", () => {
    const summary = summarizeScores([37_000, 37_000, 37_000]);

    expect(summary.stdev).toBe(0);
    expect(summary.ciLow).toBe(37_000);
    expect(summary.ciHigh).toBe(37_000);
  });
});

// UI-UT-STS-003: 空配列は呼び出し側の契約違反。0件の統計を作って返すと、部分結果
// （`completedRuns === 0`）が「全試行がスコア0」に見える。
describe("空標本の拒否 (UI-UT-STS-003)", () => {
  it("rejects an empty score sample", () => {
    expect(() => summarizeScores([])).toThrow();
  });

  it("rejects an empty completion reason sample", () => {
    expect(() => summarizeCompletionReasons([])).toThrow();
  });

  it("rejects an empty break count sample", () => {
    expect(() => summarizeBreakCounts([])).toThrow();
  });

  it("rejects an empty histogram sample and an empty quantile sample", () => {
    expect(() => buildScoreHistogram([])).toThrow();
    expect(() => quantileOfSorted([], 0.5)).toThrow();
  });
});

// UI-UT-STS-004: `ALLY_DEFEATED`の割合（5ターン走り切れない編成を弾く指標）と、
// 終了理由の内訳。未知の終了理由もコードのまま数える。
describe("summarizeCompletionReasons (UI-UT-STS-004)", () => {
  it("matches the exercise-lab defeat rate", () => {
    const summary = summarizeCompletionReasons(PYTHON_PARITY.runs.completionReasons);

    expectNumericParity(summary.defeatRate, PYTHON_PARITY.runs.defeatRate);
  });

  it("breaks the reasons down by runs and ratio, most frequent first", () => {
    const summary = summarizeCompletionReasons([
      "TURN_LIMIT_REACHED",
      "ALLY_DEFEATED",
      "TURN_LIMIT_REACHED",
      "TURN_LIMIT_REACHED",
    ]);

    expect(summary.breakdown).toEqual([
      { completionReason: "TURN_LIMIT_REACHED", runs: 3, ratio: 0.75 },
      { completionReason: "ALLY_DEFEATED", runs: 1, ratio: 0.25 },
    ]);
    expect(summary.defeatRate).toBe(0.25);
  });

  it("counts an unknown completion reason instead of dropping the run", () => {
    const summary = summarizeCompletionReasons(["SOMETHING_NEW", "ALLY_DEFEATED"]);

    expect(summary.breakdown.map((entry) => entry.completionReason)).toContain("SOMETHING_NEW");
    expect(summary.defeatRate).toBe(0.5);
  });
});

// UI-UT-STS-005: ブレイク回数分布は回数の昇順で返し、表示側の並べ替えに依存させない
// （`stats.py`の`break_count_distribution`と同じ）。
describe("summarizeBreakCounts (UI-UT-STS-005)", () => {
  it("matches the exercise-lab distribution and orders it by break count", () => {
    const summary = summarizeBreakCounts(PYTHON_PARITY.runs.breakCounts);

    expect(summary.distribution).toEqual(
      PYTHON_PARITY.runs.breakCountDistribution.map((entry) => ({
        breakCount: entry.breakCount,
        runs: entry.runs,
      })),
    );
  });

  it("averages the break count over the runs", () => {
    const summary = summarizeBreakCounts([0, 2, 2, 4]);

    expect(summary.mean).toBe(2);
    expect(summary.distribution).toEqual([
      { breakCount: 0, runs: 1 },
      { breakCount: 2, runs: 2 },
      { breakCount: 4, runs: 1 },
    ]);
  });
});

// UI-UT-STS-006: ビン数は試行数だけで決まる（Sturges、1〜60へクランプ）。同じ入力
// なら同じ図になる（`stats.py:_histogram_bins`）。
describe("histogramBinCount (UI-UT-STS-006)", () => {
  it.each(PYTHON_PARITY.cases.map((entry) => entry.name))(
    "matches the exercise-lab bin count for the %s sample",
    (name) => {
      const fixture = findCase(name);

      expect(histogramBinCount(fixture.scores.length)).toBe(fixture.histogramBinCount);
    },
  );

  it("clamps to at least one bin and at most sixty", () => {
    expect(histogramBinCount(1)).toBe(1);
    expect(histogramBinCount(0)).toBe(1);
    expect(histogramBinCount(2 ** 59)).toBe(60);
  });

  it("spreads the runs over equal-width bins that cover the whole range", () => {
    const histogram = buildScoreHistogram([10, 20, 30, 40]);

    expect(histogram.map((bin) => bin.runs).reduce((total, runs) => total + runs, 0)).toBe(4);
    expect(histogram[0]?.lowerBound).toBe(10);
    expect(histogram.at(-1)?.upperBound).toBe(40);
  });

  it("keeps a single zero-width bin when every run ties", () => {
    const histogram = buildScoreHistogram([37_000, 37_000]);

    expect(histogram).toEqual([{ lowerBound: 37_000, upperBound: 37_000, runs: 2 }]);
  });
});
