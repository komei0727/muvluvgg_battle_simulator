import { describe, expect, it } from "vitest";
import { applyStateDelta, reduceStateDeltas } from "./state-delta-reducer.js";
import type { BattleStateSnapshot } from "./battle-state-snapshot.js";
import type { EffectSnapshot, StateDelta } from "../events/state-delta.js";
import {
  createActionId,
  createEffectInstanceId,
  createSkillUseId,
} from "../../shared/event-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createMarkerId,
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
      [UNIT_A]: {
        hp: 100,
        ap: 0,
        pp: 0,
        extraGauge: 0,
        maximumAp: 3,
        maximumPp: 3,
        maximumExtraGauge: 10,
        combatStats: COMBAT_STATS,
        baseCombatStats: COMBAT_STATS,
      },
      [UNIT_B]: {
        hp: 100,
        ap: 0,
        pp: 0,
        extraGauge: 0,
        maximumAp: 3,
        maximumPp: 3,
        maximumExtraGauge: 10,
        combatStats: COMBAT_STATS,
        baseCombatStats: COMBAT_STATS,
      },
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
      maximumAp: 3,
      maximumPp: 3,
      maximumExtraGauge: 10,
      combatStats: COMBAT_STATS,
      baseCombatStats: COMBAT_STATS,
    });
    expect(next.units[UNIT_B]).toEqual({
      hp: 100,
      ap: 0,
      pp: 0,
      extraGauge: 0,
      maximumAp: 3,
      maximumPp: 3,
      maximumExtraGauge: 10,
      combatStats: COMBAT_STATS,
      baseCombatStats: COMBAT_STATS,
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

  it("UT-R-TEX-02-004: applies an exercise.totalScore delta, leaving the rest of the exercise state untouched", () => {
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 30, breakCount: 0 },
    };
    const delta: StateDelta = { exercise: { totalScore: { before: 30, after: 72 } } };

    const next = applyStateDelta(exerciseState, delta);

    expect(next.exercise).toEqual({ totalScore: 72, breakCount: 0 });
  });

  it("UT-R-TEX-02-005: throws when exercise.totalScore.before does not match the current cumulative score (dropped or reordered delta)", () => {
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 30, breakCount: 0 },
    };
    const delta: StateDelta = { exercise: { totalScore: { before: 0, after: 42 } } };

    expect(() => applyStateDelta(exerciseState, delta)).toThrow(DomainValidationError);
  });

  it("UT-R-TEX-02-006: throws when an exercise delta is applied to a state without exercise state (a normal battle can never own one)", () => {
    const delta: StateDelta = { exercise: { totalScore: { before: 0, after: 10 } } };

    expect(() => applyStateDelta(initialState(), delta)).toThrow(DomainValidationError);
  });

  it("UT-R-TEX-03-002: applies an exercise.breakCount delta independently of the cumulative score", () => {
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 72, breakCount: 1 },
    };
    const delta: StateDelta = { exercise: { breakCount: { before: 1, after: 2 } } };

    const next = applyStateDelta(exerciseState, delta);

    expect(next.exercise).toEqual({ totalScore: 72, breakCount: 2 });
  });

  it("UT-R-TEX-03-003: throws when exercise.breakCount.before does not match the current break count", () => {
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 0, breakCount: 1 },
    };
    const delta: StateDelta = { exercise: { breakCount: { before: 0, after: 1 } } };

    expect(() => applyStateDelta(exerciseState, delta)).toThrow(DomainValidationError);
  });

  it("UT-R-TEX-10-001: applies an exercise result delta, restoring a result that has no victory outcome", () => {
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 72, breakCount: 1 },
    };
    const delta: StateDelta = {
      result: {
        before: undefined,
        after: {
          completionReason: "TURN_LIMIT_REACHED",
          completedTurn: 5,
          totalScore: 72,
          breakCount: 1,
        },
      },
    };

    const next = applyStateDelta(exerciseState, delta);

    expect(next.result).toEqual({
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 5,
      totalScore: 72,
      breakCount: 1,
    });
    expect(next.result).not.toHaveProperty("outcome");
  });

  it("UT-R-TEX-10-002: throws when the exercise result's total score does not match the cumulative score restored so far (R-TEX-10 #3)", () => {
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 72, breakCount: 1 },
    };
    const delta: StateDelta = {
      result: {
        before: undefined,
        after: {
          completionReason: "TURN_LIMIT_REACHED",
          completedTurn: 5,
          totalScore: 71,
          breakCount: 1,
        },
      },
    };

    expect(() => applyStateDelta(exerciseState, delta)).toThrow(DomainValidationError);
  });

  it("UT-R-TEX-10-003: throws when the exercise result's break count does not match the count restored so far", () => {
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 72, breakCount: 1 },
    };
    const delta: StateDelta = {
      result: {
        before: undefined,
        after: {
          completionReason: "ALLY_DEFEATED",
          completedTurn: 3,
          totalScore: 72,
          breakCount: 2,
        },
      },
    };

    expect(() => applyStateDelta(exerciseState, delta)).toThrow(DomainValidationError);
  });

  it("UT-R-TEX-10-004: throws when an exercise result is applied to a state without exercise state, or a victory result to an exercise", () => {
    const exerciseResult: StateDelta = {
      result: {
        before: undefined,
        after: {
          completionReason: "ALLY_DEFEATED",
          completedTurn: 1,
          totalScore: 0,
          breakCount: 0,
        },
      },
    };
    const victoryResult: StateDelta = {
      result: {
        before: undefined,
        after: { outcome: "ALLY_LOSE", completionReason: "ALLY_DEFEATED", completedTurn: 1 },
      },
    };
    const exerciseState: BattleStateSnapshot = {
      ...initialState(),
      exercise: { totalScore: 0, breakCount: 0 },
    };

    expect(() => applyStateDelta(initialState(), exerciseResult)).toThrow(DomainValidationError);
    // R-TEX-10 #1: 演習は勝敗を持たない。
    expect(() => applyStateDelta(exerciseState, victoryResult)).toThrow(DomainValidationError);
  });

  it("UT-R-TEX-04-017: applies a units.<id>.baseCombatStats delta for the break enhancement, leaving the battle-time combatStats to their own delta", () => {
    const delta: StateDelta = {
      units: {
        [UNIT_A]: {
          baseCombatStats: {
            maximumHp: { before: 100, after: 120 },
            attack: { before: 10, after: 12 },
          },
        },
      },
    };

    const next = applyStateDelta(initialState(), delta);

    expect(next.units[UNIT_A]!.baseCombatStats).toEqual({
      ...COMBAT_STATS,
      maximumHp: 120,
      attack: 12,
    });
    // R-STA-04の2層構造: 基礎側の書き換えは戦闘中ステータスを直接動かさない
    // （強化後の再計算は`CombatStatChanged`が自分の差分として運ぶ）。
    expect(next.units[UNIT_A]!.combatStats).toEqual(COMBAT_STATS);
  });

  it("UT-R-TEX-04-018: throws when a baseCombatStats delta's before does not match the current base value", () => {
    const delta: StateDelta = {
      units: { [UNIT_A]: { baseCombatStats: { attack: { before: 99, after: 120 } } } },
    };

    expect(() => applyStateDelta(initialState(), delta)).toThrow(DomainValidationError);
  });

  it("UT-STATE-REDUCER-017 (R-SKL-05 regression): a ChargeStarted->ChargeReleased StateDelta pair restores correctly even though `before`/`after` are structurally-equal but distinct ChargeState object instances (as real events produce, since each event builds its own payload object)", () => {
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

  it("UT-STATE-REDUCER-019: a CooldownStarted->CooldownReduced delta pair restores unit/remaining/setActionId, carrying the ACTION-scope forward across a later delta that omits it", () => {
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

  it("UT-STATE-REDUCER-034 (Issue #248 で表面化した既存欠陥): a CooldownStarted that establishes a scope-less entry clears the previous setting scope instead of silently keeping the stale one", () => {
    // R-SKL-04: 行動外のトップレベルイベント（ターン開始・終了）から
    // 発動したPSのクールタイムは`setActionId`を持たないエントリとして設定し直される。
    // `establishesScope`が無いと、独立Reducerは`change.setActionId ?? existing`の
    // マージで古い`setActionId`を残し、`captureBattleState`の実状態と食い違って
    // 復元一致検証（`assembleSimulationResult`）が失敗していた
    // （`UNIT_LUCIE_MAID`のgolden battleが実戦闘の失敗として検出した）。
    const skillDefinitionId = createSkillDefinitionId("SKL_PS_CD");
    const setActionId = createActionId("battle-1:action:1");

    const started = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          cooldowns: {
            [skillDefinitionId]: {
              unit: "ACTION",
              before: 0,
              after: 1,
              setActionId,
              establishesScope: true,
            },
          },
        },
      },
    });
    expect(started.units[UNIT_A]!.cooldowns).toEqual({
      [skillDefinitionId]: { unit: "ACTION", remaining: 1, setActionId },
    });

    const restartedOutsideAction = applyStateDelta(started, {
      units: {
        [UNIT_A]: {
          cooldowns: {
            [skillDefinitionId]: { unit: "ACTION", before: 1, after: 1, establishesScope: true },
          },
        },
      },
    });
    expect(restartedOutsideAction.units[UNIT_A]!.cooldowns).toEqual({
      [skillDefinitionId]: { unit: "ACTION", remaining: 1 },
    });
  });

  it("UT-STATE-REDUCER-020: a TURN-unit CooldownStarted delta carries setTurnNumber (not setActionId)", () => {
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

  it("UT-STATE-REDUCER-025 (RuntimeCounterReset, Issue #143): after: undefined deletes the counter key entirely, unlike after: 0 which keeps it", () => {
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

  it("UT-STATE-REDUCER-026: a counter re-created after being deleted validates its before against 0 again (the deletion is not distinguishable from never having existed)", () => {
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

  it("UT-STATE-REDUCER-027: skillCounterCarry deletes the counter key (and prunes the now-empty skillDefinitionId entry entirely) when after is undefined, unlike skillCounters which keeps a landed-on-0 key", () => {
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

    // 剪定の結果、skillDefinitionIdエントリ
    // だけでなく`skillCounterCarry`フィールド自体が完全に無くなる
    // （`{}`ではなく`undefined`、`captureBattleState`が非0のcarryを1件も
    // 持たないユニットへこのフィールド自体を書かないことと一致させる）。
    expect(Object.prototype.hasOwnProperty.call(next.units[UNIT_A]!, "skillCounterCarry")).toBe(
      false,
    );
    expect(next.units[UNIT_A]!.skillCounterCarry).toBeUndefined();
  });

  it("UT-STATE-REDUCER-028: skillCounterCarry does not prune a skillDefinitionId entry that still has a sibling counter with nonzero carry", () => {
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

  it("UT-STATE-REDUCER-029 (EFF-006 Issue #212): applies an effectSequenceCounters delta, keyed by SkillUseId then RuntimeCounterId", () => {
    const skillUseId = createSkillUseId("skilluse-1");

    const next = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          effectSequenceCounters: {
            [skillUseId]: { [COUNTER_CRIT]: { before: 0, after: 1 } },
          },
        },
      },
    });

    expect(next.units[UNIT_A]!.effectSequenceCounters).toEqual({
      [skillUseId]: { [COUNTER_CRIT]: 1 },
    });
  });

  it("UT-STATE-REDUCER-030 (EFF-006 Issue #212): a RuntimeCounterReset delta (after: undefined) deletes the counter key and prunes the now-empty SkillUseId entry, removing effectSequenceCounters entirely once empty", () => {
    const skillUseId = createSkillUseId("skilluse-1");
    const withOne = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          effectSequenceCounters: {
            [skillUseId]: { [COUNTER_CRIT]: { before: 0, after: 3 } },
          },
        },
      },
    });
    expect(withOne.units[UNIT_A]!.effectSequenceCounters).toEqual({
      [skillUseId]: { [COUNTER_CRIT]: 3 },
    });

    const next = applyStateDelta(withOne, {
      units: {
        [UNIT_A]: {
          effectSequenceCounters: {
            [skillUseId]: { [COUNTER_CRIT]: { before: 3, after: undefined } },
          },
        },
      },
    });

    // EFF-006: EffectSequence自身は状態を持たないため、解決完了時の
    // RuntimeCounterResetは必ずキー自体を削除する（`skillCounters`の
    // resetScope: RESOLUTION_SCOPEと違い、値0を残す選択肢がない）。剪定の結果、
    // フィールド自体も完全に無くなる。
    expect(
      Object.prototype.hasOwnProperty.call(next.units[UNIT_A]!, "effectSequenceCounters"),
    ).toBe(false);
    expect(next.units[UNIT_A]!.effectSequenceCounters).toBeUndefined();
  });

  it("UT-STATE-REDUCER-031 (EFF-006 Issue #212): effectSequenceCounterCarry deletes the counter key and prunes the now-empty SkillUseId entry when after is undefined", () => {
    const skillUseId = createSkillUseId("skilluse-1");
    const withCarry = applyStateDelta(initialState(), {
      units: {
        [UNIT_A]: {
          effectSequenceCounterCarry: {
            [skillUseId]: { [COUNTER_CRIT]: { before: 0, after: 30 } },
          },
        },
      },
    });
    expect(withCarry.units[UNIT_A]!.effectSequenceCounterCarry).toEqual({
      [skillUseId]: { [COUNTER_CRIT]: 30 },
    });

    const next = applyStateDelta(withCarry, {
      units: {
        [UNIT_A]: {
          effectSequenceCounterCarry: {
            [skillUseId]: { [COUNTER_CRIT]: { before: 30, after: undefined } },
          },
        },
      },
    });

    expect(
      Object.prototype.hasOwnProperty.call(next.units[UNIT_A]!, "effectSequenceCounterCarry"),
    ).toBe(false);
    expect(next.units[UNIT_A]!.effectSequenceCounterCarry).toBeUndefined();
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
      categories: ["BUFF"],
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
      categories: ["BUFF"],
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

  it("UT-STATE-REDUCER-032 (M7-006、Issue #179、R-MEM-04): rejects an effects delta whose before.sourceSide disagrees with the stored Memory-granted effect", () => {
    // Memory由来の効果は`sourceUnitId`を持たず`sourceSide`を持つ。`sourceSide`が
    // 比較対象から漏れていると、発生源が欠落・破損したStateDeltaでも復元一致
    // 検証を通過してしまう。
    const memoryGranted: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "ACT_MEM_ATTACK_UP",
      sourceSide: "ALLY",
      kindKey: "ACT_MEM_ATTACK_UP",
      duplicate: true,
      isEffective: true,
      magnitude: 10,
      categories: ["BUFF"],
      appliedTurnNumber: 0,
    };
    const granted = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: {
          effects: {
            [memoryGranted.effectInstanceId]: { before: undefined, after: memoryGranted },
          },
        },
      },
    });
    expect(granted.units[UNIT_B]!.effects).toEqual([memoryGranted]);

    const { sourceSide: _omitted, ...withoutSourceSide } = memoryGranted;
    expect(() =>
      applyStateDelta(granted, {
        units: {
          [UNIT_B]: {
            effects: {
              [memoryGranted.effectInstanceId]: { before: withoutSourceSide, after: undefined },
            },
          },
        },
      }),
    ).toThrow(DomainValidationError);

    expect(() =>
      applyStateDelta(granted, {
        units: {
          [UNIT_B]: {
            effects: {
              [memoryGranted.effectInstanceId]: {
                before: { ...memoryGranted, sourceSide: "ENEMY" },
                after: undefined,
              },
            },
          },
        },
      }),
    ).toThrow(DomainValidationError);

    // 正しい`sourceSide`を持つ差分は従来どおり適用できる。
    const removed = applyStateDelta(granted, {
      units: {
        [UNIT_B]: {
          effects: {
            [memoryGranted.effectInstanceId]: { before: memoryGranted, after: undefined },
          },
        },
      },
    });
    expect(removed.units[UNIT_B]!.effects ?? []).toEqual([]);
  });

  it("UT-STATE-REDUCER-033 (M7-001E、Issue #248、R-EFF-02): rejects an effects delta whose before.categories disagrees with the stored classification", () => {
    // 分類（`effectCategoriesOf`の結果）は`TARGET_HAS_EFFECT`条件の判定入力であり、
    // 欠落・破損したまま復元されると独立Reducerの状態だけ条件成立が変わる。
    // `statusKind`/`shield`等と同じ理由で同一性比較へ含める。
    const debuff: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "ACT_TEST_ATTACK_DOWN",
      sourceUnitId: UNIT_A,
      kindKey: "ACT_TEST_ATTACK_DOWN",
      duplicate: true,
      isEffective: true,
      magnitude: -0.2,
      categories: ["DEBUFF"],
      statModStat: "ATTACK",
      appliedTurnNumber: 1,
    };
    const granted = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: { effects: { [debuff.effectInstanceId]: { before: undefined, after: debuff } } },
      },
    });
    expect(granted.units[UNIT_B]!.effects).toEqual([debuff]);

    for (const corrupted of [
      { ...debuff, categories: ["BUFF"] as const },
      { ...debuff, categories: ["DEBUFF", "STATUS"] as const },
      { ...debuff, statModStat: "DEFENSE" as const },
    ]) {
      expect(() =>
        applyStateDelta(granted, {
          units: {
            [UNIT_B]: {
              effects: { [debuff.effectInstanceId]: { before: corrupted, after: undefined } },
            },
          },
        }),
      ).toThrow(DomainValidationError);
    }

    const removed = applyStateDelta(granted, {
      units: {
        [UNIT_B]: { effects: { [debuff.effectInstanceId]: { before: debuff, after: undefined } } },
      },
    });
    expect(removed.units[UNIT_B]!.effects ?? []).toEqual([]);
  });

  it("UT-R-DMG-04-014 (DMG-002、Issue #192、R-DMG-04): an APPLY_DAMAGE_MOD delta round-trips its direction, damageType and dynamic condition through the independent Reducer", () => {
    const damageMod: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "ACT_KEI_JACKKNIFE_PS1_DMG_DOWN",
      sourceUnitId: UNIT_A,
      kindKey: "ACT_KEI_JACKKNIFE_PS1_DMG_DOWN",
      duplicate: true,
      isEffective: true,
      magnitude: -0.3,
      categories: ["DAMAGE_MOD", "DEBUFF"],
      damageModifier: {
        direction: "INCOMING",
        damageType: null,
        condition: {
          kind: "UNIT_STATE",
          unit: "EFFECT_OWNER",
          field: "HP_RATIO",
          op: "GTE",
          value: 0.65,
        },
      },
      appliedTurnNumber: 1,
    };

    const next = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: {
          effects: { [damageMod.effectInstanceId]: { before: undefined, after: damageMod } },
        },
      },
    });

    expect(next.units[UNIT_B]!.effects).toEqual([damageMod]);
  });

  it("UT-R-DMG-04-015 (DMG-002、Issue #192): a delta whose before.damageModifier disagrees with the stored one is rejected instead of silently accepted", () => {
    const damageMod: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD",
      sourceUnitId: UNIT_A,
      kindKey: "ACT_AOI_ELEGANT_PS2_SELF_DAMAGE_MOD",
      duplicate: true,
      isEffective: true,
      magnitude: -0.4,
      categories: ["DAMAGE_MOD", "DEBUFF"],
      damageModifier: {
        direction: "INCOMING",
        damageType: null,
        condition: {
          kind: "UNIT_HAS_MARKER",
          unit: "OPPONENT",
          markerId: createMarkerId("MARKER_AOI_ELEGANT_UKIASHI"),
        },
      },
      appliedTurnNumber: 1,
    };
    const granted = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: {
          effects: { [damageMod.effectInstanceId]: { before: undefined, after: damageMod } },
        },
      },
    });

    // 同じ`magnitude`でも、向き・ダメージ種別・条件のどれかが違えば別物として弾く。
    const { damageModifier: _dropped, ...withoutModifier } = damageMod;
    for (const staleBefore of [
      withoutModifier,
      { ...damageMod, damageModifier: { direction: "OUTGOING", damageType: null } } as const,
      { ...damageMod, damageModifier: { direction: "INCOMING", damageType: "EN" } } as const,
      {
        ...damageMod,
        damageModifier: { direction: "INCOMING", damageType: null, condition: { kind: "TRUE" } },
      } as const,
    ]) {
      expect(() =>
        applyStateDelta(granted, {
          units: {
            [UNIT_B]: {
              effects: {
                [damageMod.effectInstanceId]: { before: staleBefore, after: undefined },
              },
            },
          },
        }),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-R-EFF-01-049 (TGT-004フェーズ3、Issue #167、R-ACTN-03): an APPLY_STATUS-style delta (statusKind set) round-trips through the independent Reducer", () => {
    const stealth: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "ACT_MAO_COMMITTEE_PS2_STEALTH",
      sourceUnitId: UNIT_A,
      kindKey: "ACT_MAO_COMMITTEE_PS2_STEALTH",
      duplicate: true,
      isEffective: true,
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "STEALTH",
      duration: { unit: "SKILL_USE", remaining: 3 },
      appliedTurnNumber: 1,
    };

    const next = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: {
          effects: { [stealth.effectInstanceId]: { before: undefined, after: stealth } },
        },
      },
    });

    expect(next.units[UNIT_B]!.effects).toEqual([stealth]);
  });

  it("UT-R-EFF-01-050 (TGT-004フェーズ3、Issue #167): a delta whose before.statusKind does not match the current snapshot's statusKind is rejected (dropped/reordered delta), not silently accepted", () => {
    const stealth: EffectSnapshot = {
      effectInstanceId: createEffectInstanceId("battle-1:effect:1"),
      effectDefinitionId: "ACT_MAO_COMMITTEE_PS2_STEALTH",
      sourceUnitId: UNIT_A,
      kindKey: "ACT_MAO_COMMITTEE_PS2_STEALTH",
      duplicate: true,
      isEffective: true,
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "STEALTH",
      appliedTurnNumber: 1,
    };
    const withStealth = applyStateDelta(initialState(), {
      units: {
        [UNIT_B]: {
          effects: { [stealth.effectInstanceId]: { before: undefined, after: stealth } },
        },
      },
    });
    const { statusKind: _statusKind, ...staleBefore } = stealth;

    expect(() =>
      applyStateDelta(withStealth, {
        units: {
          [UNIT_B]: {
            effects: { [stealth.effectInstanceId]: { before: staleBefore, after: undefined } },
          },
        },
      }),
    ).toThrow(DomainValidationError);
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
      categories: ["BUFF"],
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
        [UNIT_A]: {
          hp: 100,
          ap: 2,
          pp: 3,
          extraGauge: 0,
          maximumAp: 3,
          maximumPp: 3,
          maximumExtraGauge: 10,
          combatStats: COMBAT_STATS,
          baseCombatStats: COMBAT_STATS,
        },
        [UNIT_B]: {
          hp: 80,
          ap: 3,
          pp: 3,
          extraGauge: 0,
          maximumAp: 3,
          maximumPp: 3,
          maximumExtraGauge: 10,
          combatStats: COMBAT_STATS,
          baseCombatStats: COMBAT_STATS,
        },
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
