import { describe, expect, it } from "vitest";
import { validateTacticalExerciseEvaluationResponse } from "./response-validator.js";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    completedRuns: 2,
    scores: [1234567, 1198200],
    breakCounts: [3, 2],
    completedTurns: [5, 5],
    completionReasons: ["TURN_LIMIT_REACHED", "ALLY_DEFEATED"],
    allyUnitDamageTotals: [
      [521000, 388000],
      [498200, 402100],
    ],
    allyUnitBreakCounts: [
      [2, 1],
      [1, 1],
    ],
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    catalogRevision: "2026-06-28.1",
    seed: "abc123#0",
    runsPerCandidate: 2,
    candidates: [candidate()],
    ...overrides,
  };
}

function expectMismatch(value: unknown): void {
  const result = validateTacticalExerciseEvaluationResponse(value);
  expect(result.ok).toBe(false);
  expect(result.ok ? undefined : result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
}

// UI-UT-API-018: 一括評価の200を受理し、6配列の長さの整合を検証する。
describe("validateTacticalExerciseEvaluationResponse", () => {
  it("accepts a well-formed evaluation response", () => {
    const result = validateTacticalExerciseEvaluationResponse(body());

    expect(result.ok).toBe(true);
    expect(result.ok ? result.response.candidates[0]?.completedRuns : undefined).toBe(2);
  });

  it("accepts a partial result whose completedRuns is below the requested runs", () => {
    const result = validateTacticalExerciseEvaluationResponse(
      body({ runsPerCandidate: 300, candidates: [candidate()] }),
    );

    expect(result.ok).toBe(true);
  });

  // 期限到達で1試行も終わらなかったチャンクも契約どおりの応答である。結果なしとして
  // 扱うのは実行側であり、検証で落とすと部分結果の集約そのものが止まる。
  it("accepts a candidate that completed no run at all", () => {
    const result = validateTacticalExerciseEvaluationResponse(
      body({
        candidates: [
          candidate({
            completedRuns: 0,
            scores: [],
            breakCounts: [],
            completedTurns: [],
            completionReasons: [],
            allyUnitDamageTotals: [],
            allyUnitBreakCounts: [],
          }),
        ],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a body that is not an object, or one missing the envelope fields", () => {
    expectMismatch(null);
    expectMismatch(body({ schemaVersion: "1" }));
    expectMismatch(body({ catalogRevision: "" }));
    expectMismatch(body({ seed: "" }));
    expectMismatch(body({ runsPerCandidate: 0 }));
    expectMismatch(body({ candidates: {} }));
  });

  // 候補は常に1件で送る（`exercise-request-mapper.ts`）。0件・2件の応答は要求と対応が
  // 取れず、どの編成の値か決められない。
  it("rejects a response that does not carry exactly one candidate", () => {
    expectMismatch(body({ candidates: [] }));
    expectMismatch(body({ candidates: [candidate(), candidate()] }));
  });

  it("rejects an array whose length disagrees with completedRuns", () => {
    expectMismatch(body({ candidates: [candidate({ scores: [1] })] }));
    expectMismatch(body({ candidates: [candidate({ breakCounts: [1, 2, 3] })] }));
    expectMismatch(
      body({ candidates: [candidate({ completionReasons: ["TURN_LIMIT_REACHED"] })] }),
    );
    expectMismatch(body({ candidates: [candidate({ allyUnitDamageTotals: [[1, 2]] })] }));
  });

  it("rejects per-run values that are not integers", () => {
    expectMismatch(body({ candidates: [candidate({ scores: [1.5, 2] })] }));
    expectMismatch(body({ candidates: [candidate({ completedTurns: [5, "5"] })] }));
    expectMismatch(body({ candidates: [candidate({ completionReasons: ["OK", 1] })] }));
    expectMismatch(
      body({
        candidates: [
          candidate({
            allyUnitBreakCounts: [
              [1, 1],
              [1, null],
            ],
          }),
        ],
      }),
    );
  });

  // ユニット別の配列は編成順の列である。試行ごとに列数が違うと、どの列がどのユニットか
  // 決まらない（`exercise-stats`のユニット別集計もこの前提で列を読む）。
  it("rejects per-unit rows whose length differs between runs", () => {
    expectMismatch(
      body({
        candidates: [
          candidate({
            allyUnitDamageTotals: [
              [1, 2],
              [1, 2, 3],
            ],
          }),
        ],
      }),
    );
    expectMismatch(
      body({
        candidates: [
          candidate({
            allyUnitBreakCounts: [[1, 1], [1]],
          }),
        ],
      }),
    );
  });

  // 与ダメージ列とブレイク列は同じ編成の同じ枠を指す。列数が食い違う応答は、
  // どちらかがユニットと対応しない。
  it("rejects a response whose damage and break columns disagree in width", () => {
    expectMismatch(
      body({
        candidates: [
          candidate({
            allyUnitBreakCounts: [
              [1, 1, 0],
              [1, 1, 0],
            ],
          }),
        ],
      }),
    );
  });

  it("accepts unknown additional properties on the envelope and the candidate", () => {
    const result = validateTacticalExerciseEvaluationResponse(
      body({ generatedAt: "2026-08-19T00:00:00Z", candidates: [candidate({ extra: true })] }),
    );

    expect(result.ok).toBe(true);
  });
});
