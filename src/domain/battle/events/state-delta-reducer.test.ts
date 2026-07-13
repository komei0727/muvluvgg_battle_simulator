import { describe, expect, it } from "vitest";
import { applyStateDelta, reduceStateDeltas } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";
import type { StateDelta } from "./state-delta.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnitId } from "../../shared/ids.js";

const UNIT_A = createBattleUnitId("unit-a");
const UNIT_B = createBattleUnitId("unit-b");

function initialState(): BattleStateSnapshot {
  return {
    status: "READY",
    currentTurn: 0,
    units: {
      [UNIT_A]: { hp: 100, ap: 0, pp: 0, extraGauge: 0 },
      [UNIT_B]: { hp: 100, ap: 0, pp: 0, extraGauge: 0 },
    },
  };
}

describe("applyStateDelta", () => {
  it("UT-STATE-REDUCER-001: applies a battleStatus change without touching units", () => {
    const next = applyStateDelta(initialState(), {
      battleStatus: { before: "READY", after: "RUNNING" },
    });

    expect(next.status).toBe("RUNNING");
    expect(next.units).toEqual(initialState().units);
  });

  it("UT-STATE-REDUCER-002: applies a turnNumber change", () => {
    const next = applyStateDelta(initialState(), { turnNumber: { before: 0, after: 1 } });

    expect(next.currentTurn).toBe(1);
  });

  it("UT-STATE-REDUCER-003: merges only the changed unit fields, leaving other fields and other units untouched", () => {
    const delta: StateDelta = {
      units: { [UNIT_A]: { hp: { before: 100, after: 80 } } },
    };

    const next = applyStateDelta(initialState(), delta);

    expect(next.units[UNIT_A]).toEqual({ hp: 80, ap: 0, pp: 0, extraGauge: 0 });
    expect(next.units[UNIT_B]).toEqual({ hp: 100, ap: 0, pp: 0, extraGauge: 0 });
  });

  it("UT-STATE-REDUCER-004: an empty delta returns an equivalent state unchanged", () => {
    const next = applyStateDelta(initialState(), {});

    expect(next).toEqual(initialState());
  });

  it("UT-STATE-REDUCER-005: does not mutate the input state", () => {
    const state = initialState();
    applyStateDelta(state, { units: { [UNIT_A]: { hp: { before: 100, after: 1 } } } });

    expect(state.units[UNIT_A]!.hp).toBe(100);
  });

  it("UT-STATE-REDUCER-007: throws when a unit delta references a BattleUnitId absent from the current state", () => {
    const delta: StateDelta = {
      units: { [createBattleUnitId("unit-missing")]: { hp: { before: 100, after: 80 } } },
    };

    expect(() => applyStateDelta(initialState(), delta)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-008: throws when a unit field's before does not match the current value (dropped or reordered delta)", () => {
    const delta: StateDelta = { units: { [UNIT_A]: { hp: { before: 50, after: 30 } } } };

    expect(() => applyStateDelta(initialState(), delta)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-009: throws when battleStatus.before does not match the current status", () => {
    const delta: StateDelta = { battleStatus: { before: "RUNNING", after: "COMPLETED" } };

    expect(() => applyStateDelta(initialState(), delta)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-010: throws when turnNumber.before does not match the current turn", () => {
    const delta: StateDelta = { turnNumber: { before: 5, after: 6 } };

    expect(() => applyStateDelta(initialState(), delta)).toThrow(DomainValidationError);
  });
});

describe("reduceStateDeltas", () => {
  const orderedDeltas: readonly StateDelta[] = [
    { battleStatus: { before: "READY", after: "RUNNING" } },
    { turnNumber: { before: 0, after: 1 } },
    {
      units: {
        [UNIT_A]: { ap: { before: 0, after: 3 }, pp: { before: 0, after: 3 } },
        [UNIT_B]: { ap: { before: 0, after: 3 }, pp: { before: 0, after: 3 } },
      },
    },
    { units: { [UNIT_A]: { ap: { before: 3, after: 2 } } } },
    { units: { [UNIT_B]: { hp: { before: 100, after: 80 } } } },
    { battleStatus: { before: "RUNNING", after: "COMPLETED" } },
  ];

  it("UT-STATE-REDUCER-006: folds an ordered sequence of deltas onto the initial state (initialState + transitions = finalState)", () => {
    const finalState = reduceStateDeltas(initialState(), orderedDeltas);

    expect(finalState).toEqual({
      status: "COMPLETED",
      currentTurn: 1,
      units: {
        [UNIT_A]: { hp: 100, ap: 2, pp: 3, extraGauge: 0 },
        [UNIT_B]: { hp: 80, ap: 3, pp: 3, extraGauge: 0 },
      },
    });
  });

  it("UT-STATE-REDUCER-011: throws when a delta is dropped from the sequence (later before no longer matches)", () => {
    const withOneDropped = [...orderedDeltas.slice(0, 2), ...orderedDeltas.slice(3)];

    expect(() => reduceStateDeltas(initialState(), withOneDropped)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-012: throws when the sequence is applied in reverse order", () => {
    const reversed = [...orderedDeltas].reverse();

    expect(() => reduceStateDeltas(initialState(), reversed)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-013: throws when a delta is duplicated in the sequence", () => {
    const withDuplicate = [orderedDeltas[0]!, orderedDeltas[0]!, ...orderedDeltas.slice(1)];

    expect(() => reduceStateDeltas(initialState(), withDuplicate)).toThrow(DomainValidationError);
  });
});
