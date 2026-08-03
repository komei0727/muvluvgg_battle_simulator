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

function validResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    battleId: "battle-01J",
    catalogRevision: "rev-1",
    result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
    initialState: validState({ turnNumber: 0 }),
    finalState: validState({ turnNumber: 3, battleStatus: "COMPLETED" }),
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
});
