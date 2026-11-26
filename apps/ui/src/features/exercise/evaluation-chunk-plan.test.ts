import { describe, expect, it } from "vitest";
import {
  EVALUATION_CHUNK_SIZE,
  generateEvaluationSeed,
  mergeEvaluationChunks,
  planEvaluationChunks,
} from "./evaluation-chunk-plan.js";
import type { EvaluationChunkPlan, EvaluationChunkResult } from "./evaluation-chunk-plan.js";
import type { TacticalExerciseEvaluationRequest } from "../../shared/api/api-contract.js";
import {
  evaluationResponseFor,
  type EvaluationResponseOptions,
} from "../../test/evaluation-response.js";

// UI-UT-EVL-001: 1,000試行は300×3＋100へ割れ、各チャンクは全体の通し試行番号の連続区間を
// 持つ。seedはチャンクで変えない（乱数列は`(seed, runIndex)`だけで決まる）。
describe("planEvaluationChunks", () => {
  it("splits the requested runs into chunk-size batches of contiguous global run indices", () => {
    const chunks = planEvaluationChunks({ totalRuns: 1000, chunkSize: 300 });

    expect(chunks.map((chunk) => chunk.runIndices.length)).toEqual([300, 300, 300, 100]);
    expect(chunks.map((chunk) => [chunk.runIndices[0], chunk.runIndices.at(-1)])).toEqual([
      [0, 299],
      [300, 599],
      [600, 899],
      [900, 999],
    ]);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
  });

  it("uses the evaluation request limit as the default chunk size", () => {
    expect(planEvaluationChunks({ totalRuns: 301 }).map((c) => c.runIndices.length)).toEqual([
      EVALUATION_CHUNK_SIZE,
      1,
    ]);
  });

  it("covers the same run indices whatever the chunk size", () => {
    const flatten = (chunkSize: number) =>
      planEvaluationChunks({ totalRuns: 250, chunkSize }).flatMap((c) => c.runIndices);

    expect(flatten(7)).toEqual(flatten(300));
    expect(flatten(300)).toEqual(Array.from({ length: 250 }, (_value, index) => index));
  });

  it("rejects a non-positive total or chunk size", () => {
    expect(() => planEvaluationChunks({ totalRuns: 0 })).toThrow(RangeError);
    expect(() => planEvaluationChunks({ totalRuns: 1.5 })).toThrow(RangeError);
    expect(() => planEvaluationChunks({ totalRuns: 10, chunkSize: 0 })).toThrow(RangeError);
  });
});

// UI-UT-EVL-002: seed未入力のときだけ自動生成する。生成値は実行の再現キーになる。
describe("generateEvaluationSeed", () => {
  it("generates a non-empty seed that differs between runs", () => {
    const first = generateEvaluationSeed();
    const second = generateEvaluationSeed();

    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(second).not.toBe(first);
  });
});

function requestFor(plan: EvaluationChunkPlan, allyUnits = ["UNIT_A", "UNIT_B"]) {
  const formation = (ids: readonly string[]) => ({
    units: ids.map((unitDefinitionId) => ({
      unitDefinitionId,
      position: { column: 0 as const, row: "FRONT" as const },
    })),
    memoryDefinitionIds: [],
  });
  const request: TacticalExerciseEvaluationRequest = {
    seed: "s",
    cases: [
      {
        caseId: "exercise",
        allyFormation: formation(allyUnits),
        enemyFormation: formation(["UNIT_ENEMY"]),
        runIndices: plan.runIndices,
      },
    ],
  };
  return request;
}

function chunkResult(
  plan: EvaluationChunkPlan,
  options: EvaluationResponseOptions = {},
  allyUnits?: readonly string[],
): EvaluationChunkResult {
  return {
    plan,
    response: evaluationResponseFor(requestFor(plan, allyUnits as string[]), options),
  };
}

const [CHUNK_0, CHUNK_1] = planEvaluationChunks({ totalRuns: 4, chunkSize: 2 }) as [
  EvaluationChunkPlan,
  EvaluationChunkPlan,
];

// UI-UT-EVL-003: チャンクの試行レコードを送信順・試行番号順に1つの標本へ投影する。
describe("mergeEvaluationChunks", () => {
  it("projects every run record of every chunk into the per-run arrays in send order", () => {
    const merged = mergeEvaluationChunks([
      chunkResult(CHUNK_0, {
        run: (runIndex) => ({ allyDamage: [runIndex, 10 * runIndex], allyBreaks: [1, 0] }),
      }),
      chunkResult(CHUNK_1, {
        run: (runIndex) => ({
          allyDamage: [runIndex, 10 * runIndex],
          allyBreaks: [0, 2],
          breakCount: 3,
        }),
      }),
    ]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.aggregate.sample).toEqual({
      scores: [1000, 1001, 1002, 1003],
      breakCounts: [1, 1, 3, 3],
      completedTurns: [5, 5, 5, 5],
      completionReasons: Array(4).fill("TURN_LIMIT_REACHED"),
      allyUnitDamageTotals: [
        [0, 0],
        [1, 10],
        [2, 20],
        [3, 30],
      ],
      allyUnitBreakCounts: [
        [1, 0],
        [1, 0],
        [0, 2],
        [0, 2],
      ],
    });
    expect(merged.aggregate).toMatchObject({
      sentRuns: 4,
      completedRuns: 4,
      catalogRevision: "rev-1",
      engineRevision: "engine-1",
      seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
      chunkSize: 2,
      incompleteRunIndices: [],
    });
  });

  // UI-UT-CSV-001: CSVの`run_index`／`chunk_index`は連結後の標本からは復元できない
  // （部分結果があると位置と番号がずれる）ため、試行ごとに出所を残す。
  it("records the global run index and the chunk of each run", () => {
    const merged = mergeEvaluationChunks([chunkResult(CHUNK_0), chunkResult(CHUNK_1)]);

    expect(merged.ok ? merged.aggregate.runs : []).toEqual([
      { runIndex: 0, chunkIndex: 0 },
      { runIndex: 1, chunkIndex: 0 },
      { runIndex: 2, chunkIndex: 1 },
      { runIndex: 3, chunkIndex: 1 },
    ]);
  });

  it("keeps a partial chunk as a shorter sample and lists its incomplete run indices without renumbering", () => {
    const merged = mergeEvaluationChunks([
      chunkResult(CHUNK_0, { completed: 1 }),
      chunkResult(CHUNK_1),
    ]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.aggregate.completedRuns).toBe(3);
    expect(merged.aggregate.sentRuns).toBe(4);
    expect(merged.aggregate.incompleteRunIndices).toEqual([1]);
    expect(merged.aggregate.runs.map((run) => run.runIndex)).toEqual([0, 2, 3]);
  });

  it("aggregates only the chunks that completed before a cancellation", () => {
    const merged = mergeEvaluationChunks([chunkResult(CHUNK_0)]);

    expect(merged.ok ? [merged.aggregate.sentRuns, merged.aggregate.completedRuns] : []).toEqual([
      2, 2,
    ]);
  });

  it.each([
    ["catalogRevision", { catalogRevision: "rev-2" }, "rev-2"],
    ["engineRevision", { engineRevision: "engine-2" }, "engine-2"],
    ["seedDerivationVersion", { seedDerivationVersion: "V2" }, "V2"],
  ] as const)(
    "reports a %s that changed between chunks instead of mixing them",
    (field, options, actual) => {
      const merged = mergeEvaluationChunks([chunkResult(CHUNK_0), chunkResult(CHUNK_1, options)]);

      expect(merged).toMatchObject({ ok: false, reason: "RUN_CONDITIONS_CHANGED", field, actual });
    },
  );

  it("reports an ally slot count that changed between chunks", () => {
    const merged = mergeEvaluationChunks([
      chunkResult(CHUNK_0),
      chunkResult(CHUNK_1, {}, ["UNIT_A"]),
    ]);

    expect(merged).toEqual({
      ok: false,
      reason: "UNIT_COLUMN_COUNT_CHANGED",
      unitCount: 2,
      chunkUnitCount: 1,
    });
  });

  it("accepts chunks that completed no run alongside chunks that did", () => {
    const merged = mergeEvaluationChunks([
      chunkResult(CHUNK_0, { completed: 0 }),
      chunkResult(CHUNK_1),
    ]);

    expect(merged.ok ? merged.aggregate.incompleteRunIndices : undefined).toEqual([0, 1]);
  });

  it("rejects an empty chunk list", () => {
    expect(() => mergeEvaluationChunks([])).toThrow(RangeError);
  });
});
