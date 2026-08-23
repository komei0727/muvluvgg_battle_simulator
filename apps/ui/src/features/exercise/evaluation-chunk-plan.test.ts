import { describe, expect, it } from "vitest";
import {
  EVALUATION_CHUNK_SIZE,
  generateEvaluationSeed,
  mergeEvaluationChunks,
  planEvaluationChunks,
} from "./evaluation-chunk-plan.js";
import type { EvaluationChunkResult } from "./evaluation-chunk-plan.js";
import type { TacticalExerciseCandidateEvaluationResponse } from "../../shared/api/api-contract.js";

// UI-UT-EVL-001: 1,000試行は300×3＋100へ割れ、各チャンクは通し試行番号を埋めた
// 別seedを持つ（`runner.py:plan_chunks`）。
describe("planEvaluationChunks", () => {
  it("splits the requested runs into chunk-size batches with a run-offset seed each", () => {
    const chunks = planEvaluationChunks({ totalRuns: 1000, baseSeed: "abc" });

    expect(chunks).toEqual([
      { index: 0, seed: "abc#0", runs: 300, runOffset: 0 },
      { index: 1, seed: "abc#300", runs: 300, runOffset: 300 },
      { index: 2, seed: "abc#600", runs: 300, runOffset: 600 },
      { index: 3, seed: "abc#900", runs: 100, runOffset: 900 },
    ]);
  });

  it("uses the evaluation request limit as the default chunk size", () => {
    expect(EVALUATION_CHUNK_SIZE).toBe(300);
  });

  it("produces a single full chunk when the total equals the chunk size", () => {
    expect(planEvaluationChunks({ totalRuns: 300, baseSeed: "s" })).toEqual([
      { index: 0, seed: "s#0", runs: 300, runOffset: 0 },
    ]);
  });

  it("produces a single one-run chunk for the smallest run count", () => {
    expect(planEvaluationChunks({ totalRuns: 1, baseSeed: "s" })).toEqual([
      { index: 0, seed: "s#0", runs: 1, runOffset: 0 },
    ]);
  });

  it("rejects a non-positive total or chunk size", () => {
    expect(() => planEvaluationChunks({ totalRuns: 0, baseSeed: "s" })).toThrow(RangeError);
    expect(() => planEvaluationChunks({ totalRuns: 10, baseSeed: "s", chunkSize: 0 })).toThrow(
      RangeError,
    );
  });

  // 同じ（seed, チャンクサイズ, 実行回数）なら送信seedもチャンク境界も同じになる。
  it("plans the same chunks for the same seed, chunk size and total", () => {
    const first = planEvaluationChunks({ totalRuns: 700, baseSeed: "seed-1" });
    const second = planEvaluationChunks({ totalRuns: 700, baseSeed: "seed-1" });

    expect(second).toEqual(first);
  });
});

// UI-UT-EVL-002: seed未入力のときだけ自動生成する。生成値は実行の再現キーになるため
// 応答の`seed`ではなくこの値を表示へ残す。
describe("generateEvaluationSeed", () => {
  it("generates a non-empty seed that differs between runs", () => {
    const first = generateEvaluationSeed();
    const second = generateEvaluationSeed();

    expect(first).toMatch(/^[0-9a-f]+$/);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(second).not.toBe(first);
  });
});

function candidate(
  overrides: Partial<TacticalExerciseCandidateEvaluationResponse> = {},
): TacticalExerciseCandidateEvaluationResponse {
  return {
    completedRuns: 2,
    scores: [10, 20],
    breakCounts: [1, 2],
    completedTurns: [5, 5],
    completionReasons: ["TURN_LIMIT_REACHED", "ALLY_DEFEATED"],
    allyUnitDamageTotals: [
      [6, 4],
      [12, 8],
    ],
    allyUnitBreakCounts: [
      [1, 0],
      [1, 1],
    ],
    ...overrides,
  };
}

function chunkResult(
  index: number,
  runs: number,
  candidateOverrides: Partial<TacticalExerciseCandidateEvaluationResponse> = {},
  catalogRevision = "rev-1",
): EvaluationChunkResult {
  return {
    plan: { index, seed: `s#${(index * runs).toString()}`, runs, runOffset: index * runs },
    candidate: candidate(candidateOverrides),
    catalogRevision,
  };
}

// UI-UT-EVL-003: チャンクは送信順に連結する。統計は`completedRuns`ではなく配列長から
// 出るため、部分結果はそのまま短い標本として積む。
describe("mergeEvaluationChunks", () => {
  it("concatenates the per-run arrays of every chunk in send order", () => {
    const merged = mergeEvaluationChunks([chunkResult(0, 2), chunkResult(1, 2)]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    expect(merged.aggregate.sentRuns).toBe(4);
    expect(merged.aggregate.completedRuns).toBe(4);
    expect(merged.aggregate.catalogRevision).toBe("rev-1");
    expect(merged.aggregate.sample.scores).toEqual([10, 20, 10, 20]);
    expect(merged.aggregate.sample.allyUnitDamageTotals).toEqual([
      [6, 4],
      [12, 8],
      [6, 4],
      [12, 8],
    ]);
  });

  // UI-UT-CSV-001: CSVの`chunk_index`/`chunk_seed`/`run_index_in_chunk`は連結後の
  // 標本からは復元できない（部分結果があるとチャンク境界が試行数で割り切れない）ため、
  // 連結と同じ場所で試行ごとに残す。
  it("records the chunk each run came from in send order", () => {
    const merged = mergeEvaluationChunks([chunkResult(0, 2), chunkResult(1, 2)]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    // 実行を再現する鍵はseed単独ではなく（seed, チャンクサイズ, 実行回数）である。
    expect(merged.aggregate.chunkSize).toBe(2);
    expect(merged.aggregate.runs).toEqual([
      { chunkIndex: 0, chunkSeed: "s#0", runIndexInChunk: 0 },
      { chunkIndex: 0, chunkSeed: "s#0", runIndexInChunk: 1 },
      { chunkIndex: 1, chunkSeed: "s#2", runIndexInChunk: 0 },
      { chunkIndex: 1, chunkSeed: "s#2", runIndexInChunk: 1 },
    ]);
  });

  it("keeps a partial chunk as a shorter sample without padding it", () => {
    const partial = chunkResult(1, 2, {
      completedRuns: 1,
      scores: [30],
      breakCounts: [0],
      completedTurns: [5],
      completionReasons: ["TURN_LIMIT_REACHED"],
      allyUnitDamageTotals: [[7, 3]],
      allyUnitBreakCounts: [[0, 0]],
    });

    const merged = mergeEvaluationChunks([chunkResult(0, 2), partial]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    expect(merged.aggregate.sentRuns).toBe(4);
    expect(merged.aggregate.completedRuns).toBe(3);
    expect(merged.aggregate.sample.scores).toEqual([10, 20, 30]);
  });

  // 中断は完了済みチャンクまでで確定する。ここが数えるのは送ったチャンクの合計だけで、
  // 送らなかったチャンクは入らない（利用者が入力した実行回数はこの値ではない）。
  it("aggregates only the chunks that completed before a cancellation", () => {
    const merged = mergeEvaluationChunks([chunkResult(0, 2)]);

    expect(merged.ok).toBe(true);
    if (!merged.ok) {
      return;
    }
    expect(merged.aggregate.sentRuns).toBe(2);
    expect(merged.aggregate.completedRuns).toBe(2);
  });

  it("reports a catalogRevision that changed between chunks instead of mixing them", () => {
    const merged = mergeEvaluationChunks([chunkResult(0, 2), chunkResult(1, 2, {}, "rev-2")]);

    expect(merged).toEqual({
      ok: false,
      reason: "CATALOG_REVISION_CHANGED",
      catalogRevision: "rev-1",
      chunkCatalogRevision: "rev-2",
    });
  });

  // 1レスポンス内の列数一致は`response-validator.ts`が見ている。チャンクをまたいだ
  // 一致は誰も見ていないため、崩れると統計の描画時に初めて落ちる。
  it("reports a per-unit column count that changed between chunks", () => {
    const widened = chunkResult(1, 2, {
      allyUnitDamageTotals: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      allyUnitBreakCounts: [
        [0, 0, 0],
        [0, 0, 0],
      ],
    });

    const merged = mergeEvaluationChunks([chunkResult(0, 2), widened]);

    expect(merged).toEqual({
      ok: false,
      reason: "UNIT_COLUMN_COUNT_CHANGED",
      unitCount: 2,
      chunkUnitCount: 3,
    });
  });

  it("accepts chunks that completed no run alongside chunks that did", () => {
    const empty = chunkResult(1, 2, {
      completedRuns: 0,
      scores: [],
      breakCounts: [],
      completedTurns: [],
      completionReasons: [],
      allyUnitDamageTotals: [],
      allyUnitBreakCounts: [],
    });

    const merged = mergeEvaluationChunks([chunkResult(0, 2), empty]);

    expect(merged.ok).toBe(true);
    expect(merged.ok ? merged.aggregate.completedRuns : undefined).toBe(2);
  });

  it("rejects an empty chunk list", () => {
    expect(() => mergeEvaluationChunks([])).toThrow(RangeError);
  });
});
