import { describe, expect, it } from "vitest";
import { validateTacticalExerciseResponse } from "./response-validator.js";

function validUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    battleUnitId: "battle-unit-1",
    unitDefinitionId: "UNIT_A",
    side: "ALLY",
    combatStatus: "ACTIVE",
    hp: { current: 100, maximum: 100 },
    ...overrides,
  };
}

function validState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    stateVersion: 0,
    battleStatus: "READY",
    turnNumber: 0,
    cycleNumber: 0,
    units: [validUnit()],
    actionQueue: [],
    ...overrides,
  };
}

function validResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    completionReason: "TURN_LIMIT_REACHED",
    completedTurn: 5,
    totalScore: 4200,
    breakCount: 2,
    breaks: [
      { breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 1500 },
      { breakNumber: 2, turnNumber: 4, cumulativeScoreAtBreak: 3600 },
    ],
    ...overrides,
  };
}

function validResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    battleId: "exercise-01J",
    catalogRevision: "rev-1",
    result: validResult(),
    initialState: validState({ turnNumber: 0 }),
    finalState: validState({ turnNumber: 5, battleStatus: "COMPLETED" }),
    events: [{ type: "EXERCISE_SCORE_ACCUMULATED" }],
    stateTransitions: [{}],
    ...overrides,
  };
}

// UI-API-015: `result`（総スコア・ブレイク回数・ブレイク履歴）を実行時shape検証し、
// 契約違反は`RESPONSE_CONTRACT_MISMATCH`として扱う。
describe("validateTacticalExerciseResponse", () => {
  it("accepts a well-formed exercise response", () => {
    const result = validateTacticalExerciseResponse(validResponse());

    expect(result).toEqual({ ok: true, response: validResponse() });
  });

  it("accepts a result with zero breaks", () => {
    const body = validResponse({
      result: validResult({ totalScore: 0, breakCount: 0, breaks: [] }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(true);
  });

  it("rejects a result carrying the battle `outcome` shape instead of the exercise one", () => {
    const body = validResponse({
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    });

    const result = validateTacticalExerciseResponse(body);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
  });

  it("rejects a non-integer totalScore", () => {
    const body = validResponse({ result: validResult({ totalScore: 1.5 }) });

    expect(validateTacticalExerciseResponse(body).ok).toBe(false);
  });

  it("rejects a malformed break entry", () => {
    const body = validResponse({
      result: validResult({
        breakCount: 1,
        breaks: [{ breakNumber: 1, turnNumber: 2 }],
      }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(false);
  });

  it("rejects a breaks array whose length disagrees with breakCount", () => {
    const body = validResponse({
      result: validResult({
        breakCount: 3,
        breaks: [{ breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 1500 }],
      }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(false);
  });

  it("rejects a finalState missing a battleUnitId present in initialState", () => {
    const body = validResponse({
      finalState: validState({ units: [validUnit({ battleUnitId: "battle-unit-9" })] }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(false);
  });

  it("keeps unknown exercise events in the response instead of stripping them", () => {
    const body = validResponse({ events: [{ type: "UNIT_BROKEN" }, { type: "FUTURE_EVENT" }] });

    const result = validateTacticalExerciseResponse(body);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.response.events : []).toHaveLength(2);
  });
});
