import { describe, expect, it } from "vitest";
import {
  summarizeAllyUnitBreaks,
  summarizeAllyUnitDamage,
  summarizeTopRuns,
} from "./unit-statistics.js";
import type { ExerciseStatisticsSample } from "./types.js";

const DAMAGE_TOTALS = [
  [10, 20],
  [40, 50],
  [30, 35],
  [20, 25],
];

const BREAK_COUNTS_BY_UNIT = [
  [0, 1],
  [2, 1],
  [1, 1],
  [0, 0],
];

function sample(overrides: Partial<ExerciseStatisticsSample> = {}): ExerciseStatisticsSample {
  return {
    scores: [100, 400, 300, 200],
    breakCounts: [1, 4, 2, 1],
    completedTurns: [5, 5, 5, 5],
    completionReasons: [
      "TURN_LIMIT_REACHED",
      "TURN_LIMIT_REACHED",
      "TURN_LIMIT_REACHED",
      "TURN_LIMIT_REACHED",
    ],
    allyUnitDamageTotals: DAMAGE_TOTALS,
    allyUnitBreakCounts: BREAK_COUNTS_BY_UNIT,
    ...overrides,
  };
}

// UI-UT-STS-011: ユニット別与ダメージは編成順の列で返る。寄与率は平均の合計に対する
// 割合で、run単位の割合を平均したものではない（試行間で総ダメージが違う）。
describe("summarizeAllyUnitDamage (UI-UT-STS-011)", () => {
  it("summarizes each unit column in formation order", () => {
    const [first, second] = summarizeAllyUnitDamage(DAMAGE_TOTALS);

    expect(first).toEqual({
      unitIndex: 0,
      mean: 25,
      median: 25,
      p25: 17.5,
      p75: 32.5,
      minimum: 10,
      maximum: 40,
      contribution: 25 / 57.5,
    });
    expect(second?.unitIndex).toBe(1);
    expect(second?.mean).toBe(32.5);
    expect(second?.median).toBe(30);
    expect(second?.p25).toBe(23.75);
    expect(second?.p75).toBe(38.75);
    expect(second?.contribution).toBe(32.5 / 57.5);
  });

  it("keeps the contributions summing to one", () => {
    const total = summarizeAllyUnitDamage(DAMAGE_TOTALS).reduce(
      (sum, unit) => sum + unit.contribution,
      0,
    );

    expect(total).toBeCloseTo(1, 12);
  });

  it("reports a zero contribution instead of dividing by zero when nothing dealt damage", () => {
    const summaries = summarizeAllyUnitDamage([
      [0, 0],
      [0, 0],
    ]);

    expect(summaries.map((unit) => unit.contribution)).toEqual([0, 0]);
  });

  it("works on a partial result by reading the rows that arrived", () => {
    const summaries = summarizeAllyUnitDamage(DAMAGE_TOTALS.slice(0, 2));

    expect(summaries[0]?.mean).toBe(25);
    expect(summaries[0]?.maximum).toBe(40);
  });

  it("rejects an empty sample and rows of differing width", () => {
    expect(() => summarizeAllyUnitDamage([])).toThrow();
    expect(() => summarizeAllyUnitDamage([[1, 2], [3]])).toThrow();
  });
});

// UI-UT-STS-012: ブレイクは発生源ユニットを持たないことがある（R-MEM-04のメモリー
// 由来継続ダメージなど）。ユニット別の合計と`breakCounts`の差をその残差として出す。
describe("summarizeAllyUnitBreaks (UI-UT-STS-012)", () => {
  it("averages each unit's breaks and bins the per-run counts", () => {
    const summary = summarizeAllyUnitBreaks(BREAK_COUNTS_BY_UNIT, [1, 4, 2, 1]);

    expect(summary.units[0]).toEqual({
      unitIndex: 0,
      mean: 0.75,
      runsByBreakCount: { none: 2, one: 1, two: 1, threeOrMore: 0 },
    });
    expect(summary.units[1]).toEqual({
      unitIndex: 1,
      mean: 0.75,
      runsByBreakCount: { none: 1, one: 3, two: 0, threeOrMore: 0 },
    });
  });

  it("bins four or more breaks into the same bucket as three", () => {
    const summary = summarizeAllyUnitBreaks([[3], [7]], [3, 7]);

    expect(summary.units[0]?.runsByBreakCount).toEqual({
      none: 0,
      one: 0,
      two: 0,
      threeOrMore: 2,
    });
  });

  it("averages the breaks no ally unit caused", () => {
    const summary = summarizeAllyUnitBreaks(BREAK_COUNTS_BY_UNIT, [1, 4, 2, 1]);

    expect(summary.memoryResidualMean).toBe(0.5);
  });

  it("rejects a run count that disagrees with the break count column", () => {
    expect(() => summarizeAllyUnitBreaks(BREAK_COUNTS_BY_UNIT, [1, 4])).toThrow();
  });
});

// UI-UT-STS-013: ベスト上位N runの部分集計。Nは引数で、再計算だけで別のNを得られる。
describe("summarizeTopRuns (UI-UT-STS-013)", () => {
  it("aggregates the highest scoring runs and their gap to the whole sample", () => {
    const top = summarizeTopRuns(sample(), 2);

    expect(top.requestedTopN).toBe(2);
    expect(top.runs).toBe(2);
    expect(top.meanScore).toBe(350);
    expect(top.meanScoreDelta).toBe(100);
    expect(top.units[0]).toEqual({
      unitIndex: 0,
      meanDamage: 35,
      meanDamageDelta: 10,
      meanBreakCount: 1.5,
      meanBreakCountDelta: 0.75,
    });
    expect(top.units[1]).toEqual({
      unitIndex: 1,
      meanDamage: 42.5,
      meanDamageDelta: 10,
      meanBreakCount: 1,
      meanBreakCountDelta: 0.25,
    });
  });

  it("picks the earlier run when scores tie so the subset does not depend on sort stability", () => {
    const top = summarizeTopRuns(
      sample({
        scores: [100, 100, 100, 100],
        allyUnitDamageTotals: DAMAGE_TOTALS,
      }),
      1,
    );

    expect(top.units[0]?.meanDamage).toBe(10);
  });

  it("rejects a top count below one and a sample with no runs", () => {
    expect(() => summarizeTopRuns(sample(), 0)).toThrow();
    expect(() => summarizeTopRuns(sample(), 1.5)).toThrow();
    expect(() =>
      summarizeTopRuns(
        sample({
          scores: [],
          breakCounts: [],
          completedTurns: [],
          completionReasons: [],
          allyUnitDamageTotals: [],
          allyUnitBreakCounts: [],
        }),
        10,
      ),
    ).toThrow();
  });
});

// UI-UT-STS-014: Nが試行数以上なら部分集合は標本そのもの。全体統計と一致し、差分は0。
describe("summarizeTopRuns の飽和 (UI-UT-STS-014)", () => {
  it.each([4, 10, 50])("matches the whole-sample statistics when N is %i", (topN) => {
    const top = summarizeTopRuns(sample(), topN);

    expect(top.requestedTopN).toBe(topN);
    expect(top.runs).toBe(4);
    expect(top.meanScore).toBe(250);
    expect(top.meanScoreDelta).toBe(0);
    expect(top.units.map((unit) => unit.meanDamage)).toEqual([25, 32.5]);
    expect(top.units.map((unit) => unit.meanDamageDelta)).toEqual([0, 0]);
    expect(top.units.map((unit) => unit.meanBreakCount)).toEqual([0.75, 0.75]);
    expect(top.units.map((unit) => unit.meanBreakCountDelta)).toEqual([0, 0]);
  });
});
