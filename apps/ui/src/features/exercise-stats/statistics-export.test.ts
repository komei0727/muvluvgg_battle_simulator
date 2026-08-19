import { describe, expect, it } from "vitest";
import { buildRunsCsv, buildStatisticsSummaryJson } from "./statistics-export.js";
import {
  buildScoreStatisticsReport,
  buildUnitStatisticsReport,
  resolveAllyUnitLabels,
} from "./statistics-report.js";
import type { EvaluationAggregate } from "../exercise/evaluation-chunk-plan.js";

function aggregate(): EvaluationAggregate {
  return {
    requestedRuns: 4,
    completedRuns: 3,
    catalogRevision: "rev-1",
    chunkSize: 2,
    runs: [
      { chunkIndex: 0, chunkSeed: "my seed,x#0", runIndexInChunk: 0 },
      { chunkIndex: 0, chunkSeed: "my seed,x#0", runIndexInChunk: 1 },
      { chunkIndex: 1, chunkSeed: "my seed,x#2", runIndexInChunk: 0 },
    ],
    sample: {
      scores: [100, 300, 200],
      breakCounts: [1, 3, 2],
      completedTurns: [5, 5, 4],
      completionReasons: ["TURN_LIMIT_REACHED", "TURN_LIMIT_REACHED", "ALLY_DEFEATED"],
      allyUnitDamageTotals: [
        [60, 40],
        [200, 100],
        [140, 60],
      ],
      allyUnitBreakCounts: [
        [1, 0],
        [2, 1],
        [1, 1],
      ],
    },
  };
}

const labels = resolveAllyUnitLabels(["UNIT_KOTOHA", "UNIT_SHIRANA"]);

// UI-UT-CSV-002: exercise-lab の `runs.csv` を後段の正本として読めるよう、8列の並びを
// そのまま先頭に置き、ユニット別の列だけを後ろへ足す。
describe("buildRunsCsv", () => {
  it("writes the exercise-lab column order followed by the per-unit columns", () => {
    const lines = buildRunsCsv(aggregate(), labels).split("\n");

    expect(lines[0]).toBe(
      "run_index,chunk_index,chunk_seed,run_index_in_chunk,score,break_count,completed_turn," +
        "completion_reason,unit_1_damage,unit_2_damage,unit_1_break_count,unit_2_break_count",
    );
    expect(lines[1]).toBe('0,0,"my seed,x#0",0,100,1,5,TURN_LIMIT_REACHED,60,40,1,0');
    expect(lines[3]).toBe('2,1,"my seed,x#2",0,200,2,4,ALLY_DEFEATED,140,60,1,1');
  });

  // 部分結果は行数がそのまま実試行数になる。要求数まで空行を足すと、後段が
  // 「0点で終わった試行」と「走らなかった試行」を区別できない。
  it("writes one row per completed run and ends with a newline", () => {
    const csv = buildRunsCsv(aggregate(), labels);

    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.trimEnd().split("\n")).toHaveLength(4);
  });

  it("produces the same bytes for the same aggregate", () => {
    expect(buildRunsCsv(aggregate(), labels)).toBe(buildRunsCsv(aggregate(), labels));
  });
});

// UI-UT-CSV-003: 統計サマリJSONはexercise-labの`summary.json`と同じ再現条件・同じ
// キーを持ち、UIだけが持つ日次ベスト指標とユニット別統計を足す。
describe("buildStatisticsSummaryJson", () => {
  const score = buildScoreStatisticsReport(aggregate(), "my seed,x");
  const units = buildUnitStatisticsReport(aggregate(), labels, 2);
  const summary = JSON.parse(buildStatisticsSummaryJson(score, units)) as Record<string, unknown>;

  it("carries the reproduction conditions of the run", () => {
    expect(summary["seed"]).toBe("my seed,x");
    expect(summary["chunkSize"]).toBe(2);
    expect(summary["catalogRevision"]).toBe("rev-1");
    expect(summary["requestedRuns"]).toBe(4);
    expect(summary["completedRuns"]).toBe(3);
    expect(summary["partial"]).toBe(true);
  });

  it("carries the score statistics, the daily best metrics and the completion breakdown", () => {
    expect(summary["score"]).toMatchObject({ count: 3, mean: 200 });
    expect(summary["dailyBest"]).toMatchObject({ bestOf: 5, reliable: false });
    expect(summary["defeatRate"]).toBeCloseTo(1 / 3);
    expect(summary["breakCountDistribution"]).toEqual({ "1": 1, "2": 1, "3": 1 });
  });

  it("names every unit column and keeps the unattributed break residual", () => {
    expect(summary["units"]).toEqual([
      expect.objectContaining({
        unitIndex: 0,
        unitDefinitionId: "UNIT_KOTOHA",
        displayName: "UNIT_KOTOHA",
      }),
      expect.objectContaining({ unitIndex: 1, unitDefinitionId: "UNIT_SHIRANA" }),
    ]);
    expect(summary["topRuns"]).toMatchObject({ requestedTopN: 2, runs: 2 });
    expect(summary["unattributedBreakMean"]).toBeCloseTo(0);
  });
});
