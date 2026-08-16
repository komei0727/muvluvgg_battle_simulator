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
    unitSummaries: [
      {
        battleUnitId: "battle-unit-1",
        side: "ALLY",
        damageDealt: 0,
        damageTaken: 0,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
    ],
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

  // apps/api/.../tactical-exercise-schema.ts: completedTurn は integer 1..5、
  // turnNumber は integer 1..5、breakNumber は integer >= 1。0や上限超過は
  // 契約違反であり、成功レスポンスとして表示させない。
  it("rejects completedTurn 0", () => {
    expect(
      validateTacticalExerciseResponse(validResponse({ result: validResult({ completedTurn: 0 }) }))
        .ok,
    ).toBe(false);
  });

  it("rejects a completedTurn above the fixed five-turn limit", () => {
    expect(
      validateTacticalExerciseResponse(validResponse({ result: validResult({ completedTurn: 6 }) }))
        .ok,
    ).toBe(false);
  });

  it("accepts the completedTurn boundaries 1 and 5", () => {
    for (const completedTurn of [1, 5]) {
      expect(
        validateTacticalExerciseResponse(validResponse({ result: validResult({ completedTurn }) }))
          .ok,
      ).toBe(true);
    }
  });

  it("rejects breakNumber 0", () => {
    const body = validResponse({
      result: validResult({
        breakCount: 1,
        breaks: [{ breakNumber: 0, turnNumber: 2, cumulativeScoreAtBreak: 100 }],
      }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(false);
  });

  it("rejects a break turnNumber of 0 or above the five-turn limit", () => {
    for (const turnNumber of [0, 6]) {
      const body = validResponse({
        result: validResult({
          breakCount: 1,
          breaks: [{ breakNumber: 1, turnNumber, cumulativeScoreAtBreak: 100 }],
        }),
      });
      expect(validateTacticalExerciseResponse(body).ok).toBe(false);
    }
  });

  it("accepts a break at the turn boundaries 1 and 5", () => {
    for (const turnNumber of [1, 5]) {
      const body = validResponse({
        result: validResult({
          breakCount: 1,
          breaks: [{ breakNumber: 1, turnNumber, cumulativeScoreAtBreak: 100 }],
        }),
      });
      expect(validateTacticalExerciseResponse(body).ok).toBe(true);
    }
  });

  // breakNumberに上限は無い（サーバー側schemaも minimum: 1 のみ）。
  it("accepts a large breakNumber", () => {
    const body = validResponse({
      result: validResult({
        breakCount: 1,
        breaks: [{ breakNumber: 99, turnNumber: 5, cumulativeScoreAtBreak: 100 }],
      }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(true);
  });

  it("still accepts a zero totalScore and a zero cumulativeScoreAtBreak", () => {
    const body = validResponse({
      result: validResult({
        totalScore: 0,
        breakCount: 1,
        breaks: [{ breakNumber: 1, turnNumber: 1, cumulativeScoreAtBreak: 0 }],
      }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(true);
  });

  // R-TEX-02 #5/#6: 敵回復の減算でスコアは0まで下がりうる（負にはならない）。
  it("accepts a response carrying EXERCISE_SCORE_DEDUCTED events with the score clamped to zero", () => {
    const body = validResponse({
      events: [{ type: "EXERCISE_SCORE_ACCUMULATED" }, { type: "EXERCISE_SCORE_DEDUCTED" }],
      result: validResult({ totalScore: 0, breakCount: 0, breaks: [] }),
    });

    expect(validateTacticalExerciseResponse(body).ok).toBe(true);
  });

  it("rejects a negative totalScore, since the deduction is clamped at zero", () => {
    const body = validResponse({ result: validResult({ totalScore: -1 }) });

    expect(validateTacticalExerciseResponse(body).ok).toBe(false);
  });
});
