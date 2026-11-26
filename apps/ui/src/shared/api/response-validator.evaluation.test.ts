import { describe, expect, it } from "vitest";
import { validateTacticalExerciseEvaluationResponse } from "./response-validator.js";

function unit(side: "ALLY" | "ENEMY", unitIndex: number, overrides: Record<string, unknown> = {}) {
  return {
    side,
    unitIndex,
    unitDefinitionId: side === "ALLY" ? "UNIT_A" : "UNIT_ENEMY",
    damageDealt: side === "ALLY" ? 500_000 : 0,
    damageTaken: 0,
    healingDone: 0,
    finalHp: 100,
    maximumHp: 100,
    combatStatus: "ACTIVE",
    ...overrides,
  };
}

function run(runIndex: number, overrides: Record<string, unknown> = {}) {
  return {
    runIndex,
    totalScore: 1_234_567,
    breakCount: 3,
    completionReason: "TURN_LIMIT_REACHED",
    completedTurn: 5,
    units: [unit("ALLY", 0), unit("ALLY", 1), unit("ENEMY", 0)],
    allyUnitBreaks: [
      { unitIndex: 0, unitDefinitionId: "UNIT_A", breakCount: 2 },
      { unitIndex: 1, unitDefinitionId: "UNIT_A", breakCount: 1 },
    ],
    ...overrides,
  };
}

function body(
  overrides: Record<string, unknown> = {},
  caseOverrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    seed: "abc123",
    seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
    catalogRevision: "2026-06-28.1",
    engineRevision: "engine",
    requestedRuns: 3,
    completedRuns: 2,
    partial: true,
    cases: [
      {
        caseId: "exercise",
        runs: [run(300), run(301)],
        incompleteRunIndices: [302],
        ...caseOverrides,
      },
    ],
    ...overrides,
  };
}

function expectMismatch(value: unknown): void {
  const result = validateTacticalExerciseEvaluationResponse(value);
  expect(result.ok).toBe(false);
  expect(result.ok ? undefined : result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
}

// UI-UT-API-018: 大量試行の200を受理し、試行レコードと件数・番号の整合を検証する。
describe("validateTacticalExerciseEvaluationResponse", () => {
  it("accepts a well-formed partial response", () => {
    const result = validateTacticalExerciseEvaluationResponse(body());

    expect(result.ok).toBe(true);
    expect(result.ok ? result.response.cases[0]?.runs.map((r) => r.runIndex) : []).toEqual([
      300, 301,
    ]);
  });

  // 期限到達で1試行も終わらなかったチャンクも契約どおりの応答である。結果なしとして
  // 扱うのは実行側であり、検証で落とすと部分結果の集約そのものが止まる。
  it("accepts a response that completed no run at all", () => {
    expect(
      validateTacticalExerciseEvaluationResponse(
        body({ completedRuns: 0 }, { runs: [], incompleteRunIndices: [300, 301, 302] }),
      ).ok,
    ).toBe(true);
  });

  it("rejects a body that is not an object, or one missing the reproduction conditions", () => {
    expectMismatch(null);
    for (const field of ["seed", "seedDerivationVersion", "catalogRevision", "engineRevision"]) {
      expectMismatch(body({ [field]: "" }));
    }
    expectMismatch(body({ schemaVersion: "1" }));
  });

  it("rejects a response that does not carry exactly one case", () => {
    expectMismatch(body({ cases: [] }));
    expectMismatch({ ...body(), cases: [...body().cases, ...body().cases] });
  });

  it("rejects counts that disagree with the runs and incomplete run indices", () => {
    expectMismatch(body({ completedRuns: 3 }));
    expectMismatch(body({ requestedRuns: 2 }));
    expectMismatch(body({ partial: false }));
  });

  it("rejects a run index reported twice, as completed and incomplete or as two runs", () => {
    expectMismatch(body({}, { incompleteRunIndices: [301] }));
    expectMismatch(body({}, { runs: [run(300), run(300)] }));
  });

  it("rejects per-run values that are not non-negative integers", () => {
    expectMismatch(body({}, { runs: [run(300, { totalScore: 1.5 }), run(301)] }));
    expectMismatch(body({}, { runs: [run(300, { breakCount: -1 }), run(301)] }));
    expectMismatch(body({}, { runs: [run(300, { runIndex: "300" }), run(301)] }));
    expectMismatch(body({}, { runs: [run(300, { completionReason: "" }), run(301)] }));
  });

  it("rejects ally slots that are not numbered 0..n-1 or that disagree with the break entries", () => {
    expectMismatch(
      body({}, { runs: [run(300, { units: [unit("ALLY", 1), unit("ENEMY", 0)] }), run(301)] }),
    );
    expectMismatch(
      body({}, { runs: [run(300, { allyUnitBreaks: [run(300).allyUnitBreaks[0]] }), run(301)] }),
    );
  });

  it("rejects a run whose ally slot count differs from the other runs", () => {
    expectMismatch(
      body(
        {},
        {
          runs: [
            run(300),
            run(301, {
              units: [unit("ALLY", 0), unit("ENEMY", 0)],
              allyUnitBreaks: [run(301).allyUnitBreaks[0]],
            }),
          ],
        },
      ),
    );
  });

  it("accepts unknown additional properties on the envelope, the case and the run", () => {
    expect(
      validateTacticalExerciseEvaluationResponse(
        body({ future: true }, { future: true, runs: [run(300, { future: true }), run(301)] }),
      ).ok,
    ).toBe(true);
  });
});
