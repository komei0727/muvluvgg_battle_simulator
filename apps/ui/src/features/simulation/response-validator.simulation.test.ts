import { describe, expect, it } from "vitest";
import { validateSimulationResponse } from "./response-validator.js";

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

function validSummary(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    battleUnitId: "battle-unit-1",
    side: "ALLY",
    damageDealt: 30,
    damageTaken: 0,
    healingDone: 0,
    finalHp: 100,
    maximumHp: 100,
    combatStatus: "ACTIVE",
    ...overrides,
  };
}

function validResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    battleId: "battle-01J",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: validState({ turnNumber: 0 }),
    finalState: validState({ turnNumber: 3, battleStatus: "COMPLETED" }),
    unitSummaries: [validSummary()],
    events: [{ type: "DAMAGE_APPLIED" }],
    stateTransitions: [{}],
    ...overrides,
  };
}

describe("validateSimulationResponse", () => {
  // UI-UT-SIM-000
  it("accepts a well-formed response", () => {
    const result = validateSimulationResponse(validResponse());

    expect(result).toEqual({ ok: true, response: validResponse() });
  });

  it("rejects a non-object body", () => {
    const result = validateSimulationResponse(null);

    expect(result.ok).toBe(false);
  });

  it("rejects a non-number schemaVersion", () => {
    const result = validateSimulationResponse(validResponse({ schemaVersion: "1" }));

    expect(result.ok).toBe(false);
  });

  it("rejects an empty battleId", () => {
    const result = validateSimulationResponse(validResponse({ battleId: "" }));

    expect(result.ok).toBe(false);
  });

  it("rejects an empty catalogRevision", () => {
    const result = validateSimulationResponse(validResponse({ catalogRevision: "" }));

    expect(result.ok).toBe(false);
  });

  it("rejects a result missing completionReason", () => {
    const result = validateSimulationResponse(
      validResponse({ result: { outcome: "ALLY_WIN", completedTurn: 3 } }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a result with a non-number completedTurn", () => {
    const result = validateSimulationResponse(
      validResponse({
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: "3" },
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when initialState.units is not an array", () => {
    const result = validateSimulationResponse(
      validResponse({ initialState: validState({ units: {} }) }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when finalState.units is not an array", () => {
    const result = validateSimulationResponse(
      validResponse({ finalState: validState({ units: {} }) }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when events is not an array", () => {
    const result = validateSimulationResponse(validResponse({ events: {} }));

    expect(result.ok).toBe(false);
  });

  it("rejects when stateTransitions is not an array", () => {
    const result = validateSimulationResponse(validResponse({ stateTransitions: {} }));

    expect(result.ok).toBe(false);
  });

  it("rejects a unit missing battleUnitId", () => {
    const { battleUnitId: _discarded, ...withoutBattleUnitId } = validUnit();
    const result = validateSimulationResponse(
      validResponse({ initialState: validState({ units: [withoutBattleUnitId] }) }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a unit missing unitDefinitionId", () => {
    const { unitDefinitionId: _discarded, ...withoutUnitDefinitionId } = validUnit();
    const result = validateSimulationResponse(
      validResponse({ initialState: validState({ units: [withoutUnitDefinitionId] }) }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a unit missing side", () => {
    const { side: _discarded, ...withoutSide } = validUnit();
    const result = validateSimulationResponse(
      validResponse({ initialState: validState({ units: [withoutSide] }) }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects a unit missing combatStatus", () => {
    const { combatStatus: _discarded, ...withoutCombatStatus } = validUnit();
    const result = validateSimulationResponse(
      validResponse({ initialState: validState({ units: [withoutCombatStatus] }) }),
    );

    expect(result.ok).toBe(false);
  });

  it("rejects when finalState is missing a battleUnitId present in initialState (03_API・データ連携設計.md §10 rule 5)", () => {
    const result = validateSimulationResponse(
      validResponse({
        initialState: validState({ units: [validUnit({ battleUnitId: "ally:1" })] }),
        finalState: validState({ units: [validUnit({ battleUnitId: "ally:2" })] }),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
    }
  });

  it("accepts when finalState has extra units beyond the initialState roster", () => {
    const result = validateSimulationResponse(
      validResponse({
        initialState: validState({ units: [validUnit({ battleUnitId: "ally:1" })] }),
        finalState: validState({
          units: [validUnit({ battleUnitId: "ally:1" }), validUnit({ battleUnitId: "ally:2" })],
        }),
        unitSummaries: [validSummary({ battleUnitId: "ally:1" })],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a unit with a malformed hp shape", () => {
    const result = validateSimulationResponse(
      validResponse({ initialState: validState({ units: [validUnit({ hp: { current: 1 } })] }) }),
    );

    expect(result.ok).toBe(false);
  });

  it("ignores unknown top-level and nested properties", () => {
    const result = validateSimulationResponse(
      validResponse({
        unknownTopLevel: "x",
        result: {
          outcome: "ALLY_WIN",
          completionReason: "ENEMY_DEFEATED",
          completedTurn: 3,
          extra: true,
        },
        initialState: validState({ units: [validUnit({ extra: "value" })], extraField: 1 }),
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("ignores unknown event types and state transition shapes", () => {
    const result = validateSimulationResponse(
      validResponse({
        events: [{ type: "SOME_FUTURE_EVENT", details: { anything: true } }],
        stateTransitions: [{ anyShape: "whatever" }],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("reports RESPONSE_CONTRACT_MISMATCH as the error kind on failure", () => {
    const result = validateSimulationResponse(validResponse({ battleId: "" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
    }
  });

  // ログ方針刷新2/3（Issue #464）: 3/3でサーバーは`SUMMARY`実行の`finalState`を
  // 省略する。UI/APIは別デプロイであるため、この寛容化を3/3より先に出す必要がある
  // ——旧UIのまま3/3を出すと、全実行が`finalState`必須検証でfailedになる。
  it("UI-UT-VAL-012: accepts a response without finalState, since the summary table now reads unitSummaries instead", () => {
    const { finalState: _omitted, ...withoutFinalState } = validResponse();

    const result = validateSimulationResponse(withoutFinalState);

    expect(result.ok).toBe(true);
  });

  it("UI-UT-VAL-013: still checks the initialState/finalState roster correspondence when finalState is present, so a partial final roster is not silently displayed", () => {
    const result = validateSimulationResponse(
      validResponse({
        initialState: validState({ units: [validUnit({ battleUnitId: "ally:1" })] }),
        finalState: validState({ units: [validUnit({ battleUnitId: "ally:2" })] }),
        unitSummaries: [validSummary({ battleUnitId: "ally:1" })],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("UI-UT-VAL-014: rejects a response whose unitSummaries is missing or malformed, rather than rendering an empty summary table", () => {
    const { unitSummaries: _omitted, ...withoutSummaries } = validResponse();
    expect(validateSimulationResponse(withoutSummaries).ok).toBe(false);

    expect(validateSimulationResponse(validResponse({ unitSummaries: {} })).ok).toBe(false);

    for (const field of [
      "battleUnitId",
      "side",
      "damageDealt",
      "damageTaken",
      "healingDone",
      "finalHp",
      "maximumHp",
      "combatStatus",
    ]) {
      const { [field]: _dropped, ...withoutField } = validSummary();
      expect(
        validateSimulationResponse(validResponse({ unitSummaries: [withoutField] })).ok,
        `unitSummaries entry without ${field} must be rejected`,
      ).toBe(false);
    }

    // 集計量が数値でない・負であるものは表示できる値ではない。
    expect(
      validateSimulationResponse(
        validResponse({ unitSummaries: [validSummary({ damageDealt: "30" })] }),
      ).ok,
    ).toBe(false);
    expect(
      validateSimulationResponse(
        validResponse({ unitSummaries: [validSummary({ healingDone: -1 })] }),
      ).ok,
    ).toBe(false);
  });

  it("UI-UT-VAL-015: rejects a response whose unitSummaries does not cover every initialState roster unit, since those rows would silently render as zero", () => {
    const result = validateSimulationResponse(
      validResponse({
        initialState: validState({
          units: [validUnit({ battleUnitId: "ally:1" }), validUnit({ battleUnitId: "ally:2" })],
        }),
        finalState: validState({
          units: [validUnit({ battleUnitId: "ally:1" }), validUnit({ battleUnitId: "ally:2" })],
        }),
        unitSummaries: [validSummary({ battleUnitId: "ally:1" })],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("RESPONSE_CONTRACT_MISMATCH");
    }
  });
});
