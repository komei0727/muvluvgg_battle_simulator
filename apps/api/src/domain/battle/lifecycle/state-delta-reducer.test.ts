import { describe, expect, it } from "vitest";
import { applyStateDelta, reduceStateDeltas } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";
import type { EffectSnapshot, StateDelta } from "../events/state-delta.js";
import { createActionId, createEffectInstanceId } from "../../shared/event-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";

const UNIT_A = createBattleUnitId("unit-a");
const UNIT_B = createBattleUnitId("unit-b");
const COUNTER_CRIT = createRuntimeCounterId("RUNTIME_COUNTER_CRIT");
const COUNTER_OTHER = createRuntimeCounterId("RUNTIME_COUNTER_OTHER");

const COMBAT_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function initialState(): BattleStateSnapshot {
  return {
    status: "READY",
    currentTurn: 0,
    units: {
      [UNIT_A]: { hp: 100, ap: 0, pp: 0, extraGauge: 0, combatStats: COMBAT_STATS },
      [UNIT_B]: { hp: 100, ap: 0, pp: 0, extraGauge: 0, combatStats: COMBAT_STATS },
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

    expect(next.units[UNIT_A]).toEqual({
      hp: 80,
      ap: 0,
      pp: 0,
      extraGauge: 0,
      combatStats: COMBAT_STATS,
    });
    expect(next.units[UNIT_B]).toEqual({
      hp: 100,
      ap: 0,
      pp: 0,
      extraGauge: 0,
      combatStats: COMBAT_STATS,
    });
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

  it("UT-STATE-REDUCER-021 (RuntimeCounter, Issue #143): applies a RuntimeCounterChanged delta, keyed by SkillDefinitionId then RuntimeCounterId", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");

    const next = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounters: {
            [skillDefinitionId]: { [COUNTER_CRIT]: { before: 0, after: 1 } },
          },
        },
      },
    });

    expect(next.units[UNIT_A]!.skillCounters).toEqual({
      [skillDefinitionId]: { [COUNTER_CRIT]: 1 },
    });
  });

  it("UT-STATE-REDUCER-022 (RuntimeCounter, Issue #143): a second update only replaces the changed counter, leaving sibling counters untouched", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");
    const withOne = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounters: {
            [skillDefinitionId]: {
              [COUNTER_CRIT]: { before: 0, after: 1 },
              [COUNTER_OTHER]: { before: 0, after: 5 },
            },
          },
        },
      },
    });

    const next = applyStateDelta(withOne, {
      units: {
        [UNIT_A]: {
          skillCounters: { [skillDefinitionId]: { [COUNTER_CRIT]: { before: 1, after: 2 } } },
        },
      },
    });

    expect(next.units[UNIT_A]!.skillCounters).toEqual({
      [skillDefinitionId]: { [COUNTER_CRIT]: 2, [COUNTER_OTHER]: 5 },
    });
  });

  it("UT-STATE-REDUCER-023 (RuntimeCounter, Issue #143): throws when a counter's before does not match the current value (dropped or reordered delta)", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");
    const withOne = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounters: { [skillDefinitionId]: { [COUNTER_CRIT]: { before: 0, after: 1 } } },
        },
      },
    });

    expect(() =>
      applyStateDelta(withOne, {
        units: {
          [UNIT_A]: {
            skillCounters: {
              [skillDefinitionId]: { [COUNTER_CRIT]: { before: 0, after: 2 } },
            },
          },
        },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-024 (RuntimeCounter, Issue #143): a value change landing on 0 keeps the counter key (distinct from RuntimeCounterReset's key deletion below)", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");
    const withOne = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounters: { [skillDefinitionId]: { [COUNTER_CRIT]: { before: 0, after: 3 } } },
        },
      },
    });

    const next = applyStateDelta(withOne, {
      units: {
        [UNIT_A]: {
          skillCounters: { [skillDefinitionId]: { [COUNTER_CRIT]: { before: 3, after: 0 } } },
        },
      },
    });

    expect(next.units[UNIT_A]!.skillCounters).toEqual({
      [skillDefinitionId]: { [COUNTER_CRIT]: 0 },
    });
  });

  it("UT-STATE-REDUCER-025 (review re-fix [P1], RuntimeCounterReset, Issue #143): after: undefined deletes the counter key entirely, unlike after: 0 (UT-STATE-REDUCER-024) which keeps it", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");
    const withOne = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounters: {
            [skillDefinitionId]: {
              [COUNTER_CRIT]: { before: 0, after: 1 },
              [COUNTER_OTHER]: { before: 0, after: 5 },
            },
          },
        },
      },
    });

    const next = applyStateDelta(withOne, {
      units: {
        [UNIT_A]: {
          skillCounters: {
            [skillDefinitionId]: { [COUNTER_CRIT]: { before: 1, after: undefined } },
          },
        },
      },
    });

    expect(next.units[UNIT_A]!.skillCounters).toEqual({
      [skillDefinitionId]: { [COUNTER_OTHER]: 5 },
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        next.units[UNIT_A]!.skillCounters![skillDefinitionId],
        COUNTER_CRIT,
      ),
    ).toBe(false);
  });

  it("UT-STATE-REDUCER-026 (review re-fix [P1]): a counter re-created after being deleted validates its before against 0 again (the deletion is not distinguishable from never having existed)", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");
    const withOne = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounters: { [skillDefinitionId]: { [COUNTER_CRIT]: { before: 0, after: 1 } } },
        },
      },
    });
    const afterReset = applyStateDelta(withOne, {
      units: {
        [UNIT_A]: {
          skillCounters: {
            [skillDefinitionId]: { [COUNTER_CRIT]: { before: 1, after: undefined } },
          },
        },
      },
    });

    const next = applyStateDelta(afterReset, {
      units: {
        [UNIT_A]: {
          skillCounters: { [skillDefinitionId]: { [COUNTER_CRIT]: { before: 0, after: 1 } } },
        },
      },
    });

    expect(next.units[UNIT_A]!.skillCounters).toEqual({
      [skillDefinitionId]: { [COUNTER_CRIT]: 1 },
    });
  });

  it("UT-STATE-REDUCER-027 (review re-re-fix [P1]): skillCounterCarry deletes the counter key (and prunes the now-empty skillDefinitionId entry entirely) when after is undefined, unlike skillCounters (UT-STATE-REDUCER-024) which keeps a landed-on-0 key", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");
    const withCarry = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounterCarry: { [skillDefinitionId]: { [COUNTER_CRIT]: { before: 0, after: 30 } } },
        },
      },
    });
    expect(withCarry.units[UNIT_A]!.skillCounterCarry).toEqual({
      [skillDefinitionId]: { [COUNTER_CRIT]: 30 },
    });

    // carry returns to exactly 0 (e.g. a hit that lands precisely on a
    // threshold multiple): the delta must use `after: undefined`, not `0`,
    // so this single remaining counter's entry — and the now-empty
    // skillDefinitionId-level map itself — are both removed, matching
    // `captureBattleState`'s "carry 0 is omitted entirely" convention.
    const next = applyStateDelta(withCarry, {
      units: {
        [UNIT_A]: {
          skillCounterCarry: {
            [skillDefinitionId]: { [COUNTER_CRIT]: { before: 30, after: undefined } },
          },
        },
      },
    });

    // レビュー再々々々レビュー[P1]: 剪定の結果、skillDefinitionIdエントリ
    // だけでなく`skillCounterCarry`フィールド自体が完全に無くなる
    // （`{}`ではなく`undefined`、`captureBattleState`が非0のcarryを1件も
    // 持たないユニットへこのフィールド自体を書かないことと一致させる）。
    expect(Object.prototype.hasOwnProperty.call(next.units[UNIT_A]!, "skillCounterCarry")).toBe(
      false,
    );
    expect(next.units[UNIT_A]!.skillCounterCarry).toBeUndefined();
  });

  it("UT-STATE-REDUCER-028 (review re-re-fix [P1]): skillCounterCarry does not prune a skillDefinitionId entry that still has a sibling counter with nonzero carry", () => {
    const skillDefinitionId = createSkillDefinitionId("SKL_PS1");
    const withBoth = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          skillCounterCarry: {
            [skillDefinitionId]: {
              [COUNTER_CRIT]: { before: 0, after: 30 },
              [COUNTER_OTHER]: { before: 0, after: 12 },
            },
          },
        },
      },
    });

    const next = applyStateDelta(withBoth, {
      units: {
        [UNIT_A]: {
          skillCounterCarry: {
            [skillDefinitionId]: { [COUNTER_CRIT]: { before: 30, after: undefined } },
          },
        },
      },
    });

    expect(next.units[UNIT_A]!.skillCounterCarry).toEqual({
      [skillDefinitionId]: { [COUNTER_OTHER]: 12 },
    });
  });

  it("UT-R-EFF-01-009: applies an EffectApplied-style delta (before: undefined) as a new entry in the effects registry", () => {
    const effect: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "EFFECT_ACTION_ATK_UP",
      sourceUnitId: UNIT_A,
      kindKey: "EFFECT_ACTION_ATK_UP",
      duplicate: true,
      isEffective: true,
      magnitude: 10,
      appliedTurnNumber: 1,
    };

    const next = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: { effects: { [effect.effectInstanceId]: { before: undefined, after: effect } } },
      },
    });

    expect(next.units[UNIT_B]!.effects).toEqual([effect]);
  });

  it("UT-R-EFF-01-010: individually retains multiple effect instances granted to the same unit (R-EFF-01: no merging, even for duplicate-allowed effects of the same kind)", () => {
    const first: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "EFFECT_ACTION_ATK_UP",
      sourceUnitId: UNIT_A,
      kindKey: "EFFECT_ACTION_ATK_UP",
      duplicate: true,
      isEffective: true,
      magnitude: 10,
      appliedTurnNumber: 1,
    };
    const second: EffectSnapshot = {
      ...first,
      effectInstanceId: createEffectInstanceId("battle-1:effect:2"),
    };

    const withFirst = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: { effects: { [first.effectInstanceId]: { before: undefined, after: first } } },
      },
    });
    const next = applyStateDelta(withFirst, {
      units: {
        [UNIT_B]: { effects: { [second.effectInstanceId]: { before: undefined, after: second } } },
      },
    });

    expect(next.units[UNIT_B]!.effects).toEqual([first, second]);
  });

  it("UT-R-EFF-01-011: throws when an effect delta's before does not match the current entry (dropped or reordered delta)", () => {
    const effect: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "EFFECT_ACTION_ATK_UP",
      sourceUnitId: UNIT_A,
      kindKey: "EFFECT_ACTION_ATK_UP",
      duplicate: true,
      isEffective: true,
      magnitude: 10,
      appliedTurnNumber: 1,
    };
    const staleBefore: EffectSnapshot = { ...effect, magnitude: 999 };

    expect(() =>
      applyStateDelta(initialState(), {
        units: {
          [UNIT_B]: {
            effects: { [effect.effectInstanceId]: { before: staleBefore, after: effect } },
          },
        },
      }),
    ).toThrow(DomainValidationError);
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
        [UNIT_A]: { hp: 100, ap: 2, pp: 3, extraGauge: 0, combatStats: COMBAT_STATS },
        [UNIT_B]: { hp: 80, ap: 3, pp: 3, extraGauge: 0, combatStats: COMBAT_STATS },
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
