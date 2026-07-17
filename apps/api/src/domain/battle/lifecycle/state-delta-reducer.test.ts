import { describe, expect, it } from "vitest";
import { applyStateDelta, reduceStateDeltas } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";
import type { StateDelta } from "../events/state-delta.js";
import { createActionId } from "../../shared/event-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createSkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";

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

  it("UT-STATE-REDUCER-014: applies a result delta (battle outcome becomes part of the restored state)", () => {
    const delta: StateDelta = {
      result: {
        before: undefined,
        after: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 2 },
      },
    };

    const next = applyStateDelta(initialState(), delta);

    expect(next.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 2,
    });
  });

  it("UT-STATE-REDUCER-015: throws when result.before does not match the current result (already-completed battle)", () => {
    const alreadyCompleted: BattleStateSnapshot = {
      ...initialState(),
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
    };
    const delta: StateDelta = {
      result: {
        before: undefined,
        after: { outcome: "ALLY_LOSE", completionReason: "ALLY_DEFEATED", completedTurn: 3 },
      },
    };

    expect(() => applyStateDelta(alreadyCompleted, delta)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-017 (R-SKL-05 / regression PR#128 review [P1]): a ChargeStarted->ChargeReleased StateDelta pair restores correctly even though `before`/`after` are structurally-equal but distinct ChargeState object instances (as real events produce, since each event builds its own payload object)", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_CHARGE");
    const startedActionId = createActionId("battle-1:action:1");

    const chargeStarted: StateDelta = {
      units: {
        [UNIT_A]: {
          charge: {
            before: undefined,
            // A fresh object literal, structurally equal to but not the same
            // reference as the one used by the release delta below.
            after: { skillDefinitionId, startedActionId },
          },
        },
      },
    };
    const afterStart = applyStateDelta(initialState(), chargeStarted);
    expect(afterStart.units[UNIT_A]!.charge).toEqual({ skillDefinitionId, startedActionId });

    const chargeReleased: StateDelta = {
      units: {
        [UNIT_A]: {
          charge: {
            // Deliberately a distinct object instance with the same values,
            // matching how `resolveChargeRelease` independently constructs
            // this payload from `charge.skillDefinitionId`/`startedActionId`.
            before: { skillDefinitionId, startedActionId },
            after: undefined,
          },
        },
      },
    };

    const afterRelease = applyStateDelta(afterStart, chargeReleased);
    expect(afterRelease.units[UNIT_A]!.charge).toBeUndefined();
  });

  it("UT-STATE-REDUCER-018: throws when a charge delta's `before` does not match the current charge (structural mismatch, not just reference)", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_CHARGE");
    const withCharge: BattleStateSnapshot = {
      ...initialState(),
      units: {
        ...initialState().units,
        [UNIT_A]: {
          ...initialState().units[UNIT_A]!,
          charge: { skillDefinitionId, startedActionId: createActionId("battle-1:action:1") },
        },
      },
    };
    const delta: StateDelta = {
      units: {
        [UNIT_A]: {
          charge: {
            before: { skillDefinitionId, startedActionId: createActionId("battle-1:action:2") },
            after: undefined,
          },
        },
      },
    };

    expect(() => applyStateDelta(withCharge, delta)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-016: carries an already-set result forward across a delta that does not touch it", () => {
    const completed: BattleStateSnapshot = {
      ...initialState(),
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
    };

    const next = applyStateDelta(completed, { turnNumber: { before: 0, after: 1 } });

    expect(next.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 1,
    });
  });

  it("UT-STATE-REDUCER-019 (M5 review round 2 [P1] fix): a CooldownStarted->CooldownReduced delta pair restores unit/remaining/setActionId, carrying the ACTION-scope forward across a later delta that omits it", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_CD");
    const setActionId = createActionId("battle-1:action:1");

    const started = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          cooldowns: { [skillDefinitionId]: { unit: "ACTION", before: 0, after: 2, setActionId } },
        },
      },
    });
    expect(started.units[UNIT_A]!.cooldowns).toEqual({
      [skillDefinitionId]: { unit: "ACTION", remaining: 2, setActionId },
    });

    // CooldownReduced does not resend the setting scope (it doesn't change).
    const reduced = applyStateDelta(started, {
      units: {
        [UNIT_A]: { cooldowns: { [skillDefinitionId]: { unit: "ACTION", before: 2, after: 1 } } },
      },
    });
    expect(reduced.units[UNIT_A]!.cooldowns).toEqual({
      [skillDefinitionId]: { unit: "ACTION", remaining: 1, setActionId },
    });
  });

  it("UT-STATE-REDUCER-020 (M5 review round 2 [P1] fix): a TURN-unit CooldownStarted delta carries setTurnNumber (not setActionId)", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_CD_TURN");

    const started = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          cooldowns: {
            [skillDefinitionId]: { unit: "TURN", before: 0, after: 3, setTurnNumber: 2 },
          },
        },
      },
    });

    expect(started.units[UNIT_A]!.cooldowns).toEqual({
      [skillDefinitionId]: { unit: "TURN", remaining: 3, setTurnNumber: 2 },
    });
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
