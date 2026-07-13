import { describe, expect, it } from "vitest";
import { applyStateDelta, reduceStateDeltas } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";
import type { StateDelta } from "./state-delta.js";
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
});

describe("reduceStateDeltas", () => {
  it("UT-STATE-REDUCER-006: folds an ordered sequence of deltas onto the initial state (initialState + transitions = finalState)", () => {
    const deltas: readonly StateDelta[] = [
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

    const finalState = reduceStateDeltas(initialState(), deltas);

    expect(finalState).toEqual({
      status: "COMPLETED",
      currentTurn: 1,
      units: {
        [UNIT_A]: { hp: 100, ap: 2, pp: 3, extraGauge: 0 },
        [UNIT_B]: { hp: 80, ap: 3, pp: 3, extraGauge: 0 },
      },
    });
  });
});
