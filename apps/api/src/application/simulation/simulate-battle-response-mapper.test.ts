import { describe, expect, it } from "vitest";
import type { CooldownStateResponseBody } from "../contracts/response.js";
import { toBattleSimulationResponseBody } from "./simulate-battle-response-mapper.js";
import type { SimulateBattleResult } from "./simulation-result-assembler.js";
import { createActionId } from "../../domain/shared/event-ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");
const ALLY_ID = createBattleUnitId("ally:1");
const ENEMY_ID = createBattleUnitId("enemy:1");
const SKL_A = createSkillDefinitionId("SKL_A");
const SKL_B = createSkillDefinitionId("SKL_B");
const SKL_C = createSkillDefinitionId("SKL_C");
const SKL_D = createSkillDefinitionId("SKL_D");
const ACTION_1 = createActionId("action-1");
const ACTION_2 = createActionId("action-2");

// R-NUM-01: 割合はDomain内部で1.0=100%として保持する（`percentage.ts`）。
const ALLY_COMBAT_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0.05,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};
const ENEMY_COMBAT_STATS = {
  maximumHp: 100,
  attack: 8,
  defense: 8,
  criticalRate: 0.05,
  actionSpeed: 8,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function baseResult(overrides: Partial<SimulateBattleResult> = {}): SimulateBattleResult {
  return {
    battleId: BATTLE_ID,
    catalogRevision: "rev-1",
    outcome: "ALLY_WIN",
    completionReason: "ENEMY_DEFEATED",
    completedTurn: 3,
    initialState: {
      status: "READY",
      currentTurn: 0,
      units: {
        [ALLY_ID]: { hp: 100, ap: 0, pp: 0, extraGauge: 0, combatStats: ALLY_COMBAT_STATS },
        [ENEMY_ID]: { hp: 100, ap: 0, pp: 0, extraGauge: 0, combatStats: ENEMY_COMBAT_STATS },
      },
    },
    finalState: {
      status: "COMPLETED",
      currentTurn: 1,
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
      units: {
        [ALLY_ID]: { hp: 90, ap: 1, pp: 0, extraGauge: 5, combatStats: ALLY_COMBAT_STATS },
        [ENEMY_ID]: { hp: 0, ap: 0, pp: 0, extraGauge: 0, combatStats: ENEMY_COMBAT_STATS },
      },
    },
    events: [],
    stateTransitions: [],
    unitRoster: [
      {
        battleUnitId: ALLY_ID,
        unitDefinitionId: createUnitDefinitionId("UNIT_001"),
        side: "ALLY",
        position: { column: "LEFT", row: "FRONT" },
        globalCoordinate: { x: 0, y: 2 },
        combatStats: ALLY_COMBAT_STATS,
        maximumAp: 3,
        maximumPp: 2,
        maximumExtraGauge: 100,
      },
      {
        battleUnitId: ENEMY_ID,
        unitDefinitionId: createUnitDefinitionId("UNIT_101"),
        side: "ENEMY",
        position: { column: "CENTER", row: "BACK" },
        globalCoordinate: { x: 1, y: 0 },
        combatStats: ENEMY_COMBAT_STATS,
        maximumAp: 3,
        maximumPp: 2,
        maximumExtraGauge: 100,
      },
    ],
    ...overrides,
  };
}

describe("toBattleSimulationResponseBody", () => {
  it("API-RESP-001: maps top-level schemaVersion/battleId/catalogRevision/result (10_API設計.md BattleSimulationResponse)", () => {
    const body = toBattleSimulationResponseBody(baseResult());

    expect(body.schemaVersion).toBe(1);
    expect(body.battleId).toBe("battle-1");
    expect(body.catalogRevision).toBe("rev-1");
    expect(body.result).toEqual({
      outcome: "ALLY_WIN",
      completionReason: "ENEMY_DEFEATED",
      completedTurn: 3,
    });
  });

  it("API-RESP-002: initialState always has stateVersion 0 and an empty actionQueue", () => {
    const body = toBattleSimulationResponseBody(baseResult());

    expect(body.initialState.stateVersion).toBe(0);
    expect(body.initialState.battleStatus).toBe("READY");
    expect(body.initialState.cycleNumber).toBe(0);
    expect(body.initialState.actionQueue).toEqual([]);
  });

  it("API-RESP-003: finalState.stateVersion is the last stateTransition's stateVersionAfter, or 0 when there were none", () => {
    const withTransitions = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          { causedBySequence: 1, stateVersionBefore: 0, stateVersionAfter: 1, stateDelta: {} },
          { causedBySequence: 2, stateVersionBefore: 1, stateVersionAfter: 2, stateDelta: {} },
        ],
      }),
    );
    expect(withTransitions.finalState.stateVersion).toBe(2);

    const withoutTransitions = toBattleSimulationResponseBody(baseResult());
    expect(withoutTransitions.finalState.stateVersion).toBe(0);
  });

  it("API-RESP-004: lists units in roster order (ally before enemy) with formationPosition/coordinate converted back to the per-side API representation", () => {
    const body = toBattleSimulationResponseBody(baseResult());

    expect(body.initialState.units.map((u) => u.battleUnitId)).toEqual(["ally:1", "enemy:1"]);
    const ally = body.initialState.units[0]!;
    expect(ally.unitDefinitionId).toBe("UNIT_001");
    expect(ally.side).toBe("ALLY");
    expect(ally.formationPosition).toEqual({ column: 0, row: "FRONT" });
    expect(ally.coordinate).toEqual({ x: 0, y: 2 });

    const enemy = body.initialState.units[1]!;
    // domain BACK maps back to the API's REAR spelling regardless of side.
    expect(enemy.formationPosition).toEqual({ column: 1, row: "REAR" });
  });

  it("API-RESP-005: maps hp/resources current values from the snapshot and maximums from the roster, and derives combatStatus from hp", () => {
    const body = toBattleSimulationResponseBody(baseResult());
    const finalAlly = body.finalState.units[0]!;
    const finalEnemy = body.finalState.units[1]!;

    expect(finalAlly.hp).toEqual({ current: 90, maximum: 100 });
    expect(finalAlly.resources).toEqual({
      ap: { current: 1, maximum: 3 },
      pp: { current: 0, maximum: 2 },
      extraGauge: { current: 5, maximum: 100 },
    });
    expect(finalAlly.combatStatus).toBe("ACTIVE");
    expect(finalEnemy.hp.current).toBe(0);
    expect(finalEnemy.combatStatus).toBe("DEFEATED");
  });

  it("API-RESP-006: includes real combatStats from the roster and truthfully-empty shields/subUnits/effects/cooldowns (no shield/effect mechanic exists yet, and this snapshot has no active cooldowns)", () => {
    const body = toBattleSimulationResponseBody(baseResult());
    const ally = body.initialState.units[0]!;

    expect(ally.combatStats).toEqual({
      attack: 10,
      defense: 10,
      criticalRate: 5,
      actionSpeed: 10,
      affinityBonus: 0,
      criticalDamageBonus: 50,
    });
    expect(ally.shields).toEqual({ physical: 0, energy: 0, untyped: 0 });
    expect(ally.subUnits).toEqual([]);
    expect(ally.effects).toEqual([]);
    expect(ally.cooldowns).toEqual([]);
  });

  it("API-RESP-006b (R-NUM-01 / 10_API設計.md CombatStatsResponse): converts criticalRate/affinityBonus/criticalDamageBonus from Domain's 1.0=100% ratio to percentage points, while leaving attack/defense/actionSpeed as raw magnitudes", () => {
    const base = baseResult();
    const distinctCombatStats = {
      ...ALLY_COMBAT_STATS,
      attack: 123,
      defense: 45,
      actionSpeed: 67,
      criticalRate: 0.1,
      affinityBonus: 0.25,
      criticalDamageBonus: 0.5,
    };
    const withDistinctRatios = baseResult({
      initialState: {
        ...base.initialState,
        units: {
          ...base.initialState.units,
          [ALLY_ID]: { ...base.initialState.units[ALLY_ID]!, combatStats: distinctCombatStats },
        },
      },
    });

    const body = toBattleSimulationResponseBody(withDistinctRatios);

    expect(body.initialState.units[0]!.combatStats).toEqual({
      attack: 123,
      defense: 45,
      actionSpeed: 67,
      criticalRate: 10,
      affinityBonus: 25,
      criticalDamageBonus: 50,
    });
  });

  it("API-RESP-007: maps a BattleLogEvent to BattleLogEventResponseBody, preserving optional fields only when present", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        events: [
          {
            sequence: 1,
            type: "BATTLE_STARTED",
            category: "FACT",
            turnNumber: 0,
            cycleNumber: 0,
            rootSequence: 1,
            targetUnitIds: [],
            details: { turnLimit: 3 },
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateTransitionIndex: 0,
          },
        ],
      }),
    );

    expect(body.events).toEqual([
      {
        sequence: 1,
        type: "BATTLE_STARTED",
        category: "FACT",
        turnNumber: 0,
        cycleNumber: 0,
        rootSequence: 1,
        targetUnitIds: [],
        details: { turnLimit: 3 },
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        stateTransitionIndex: 0,
      },
    ]);
  });

  it("API-RESP-008: maps a StateTransition's flat unit hp/ap/pp/extraGauge delta into the nested battle/resources shape and derives a combatStatus change on defeat", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 5,
            stateVersionBefore: 3,
            stateVersionAfter: 4,
            stateDelta: {
              battleStatus: { before: "RUNNING", after: "COMPLETED" },
              units: {
                [ENEMY_ID]: { hp: { before: 10, after: 0 } },
              },
            },
          },
        ],
      }),
    );

    expect(body.stateTransitions).toEqual([
      {
        causedBySequence: 5,
        stateVersionBefore: 3,
        stateVersionAfter: 4,
        delta: {
          battle: { battleStatus: { before: "RUNNING", after: "COMPLETED" } },
          units: {
            "enemy:1": {
              hp: { before: 10, after: 0 },
              combatStatus: { before: "ACTIVE", after: "DEFEATED" },
            },
          },
        },
      },
    ]);
  });

  it("API-RESP-009: maps ap/pp/extraGauge deltas under resources without a combatStatus change when hp is untouched", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 2,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: { units: { [ALLY_ID]: { ap: { before: 0, after: 3 } } } },
          },
        ],
      }),
    );

    expect(body.stateTransitions[0]!.delta).toEqual({
      units: { "ally:1": { resources: { ap: { before: 0, after: 3 } } } },
    });
  });

  it("API-RESP-010 (P1 fix): maps a unit's real cooldowns (10_API設計.md CooldownStateResponse, filtering out any zero-remaining entries) and charge instead of discarding them", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        finalState: {
          status: "COMPLETED",
          currentTurn: 1,
          result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
          units: {
            [ALLY_ID]: {
              hp: 90,
              ap: 1,
              pp: 0,
              extraGauge: 5,
              combatStats: ALLY_COMBAT_STATS,
              cooldowns: {
                [SKL_A]: { unit: "ACTION", remaining: 2, setActionId: ACTION_1 },
                [SKL_B]: { unit: "TURN", remaining: 1, setTurnNumber: 3 },
                // A completed cooldown the domain still tracks internally but is no
                // longer "active" (10_API設計.md: cooldowns lists only skills with
                // remaining > 0).
                [SKL_C]: { unit: "ACTION", remaining: 0, setActionId: ACTION_1 },
              },
              charge: { skillDefinitionId: SKL_D, startedActionId: ACTION_2 },
            },
            [ENEMY_ID]: {
              hp: 0,
              ap: 0,
              pp: 0,
              extraGauge: 0,
              combatStats: ENEMY_COMBAT_STATS,
            },
          },
        },
      }),
    );

    const finalAlly = body.finalState.units[0]!;
    expect(finalAlly.cooldowns).toEqual([
      { skillDefinitionId: "SKL_A", unit: "ACTION", remaining: 2, setAtActionId: "action-1" },
      { skillDefinitionId: "SKL_B", unit: "TURN", remaining: 1, setAtTurnNumber: 3 },
    ]);
    expect(finalAlly.charge).toEqual({
      skillDefinitionId: "SKL_D",
      startedActionId: "action-2",
      status: "CHARGING",
    });
  });

  it("API-RESP-010B (M5 review round 3 [P2] fix): throws instead of silently producing an invalid CooldownStateResponse when a Domain cooldown's unit/setActionId/setTurnNumber XOR is violated (ACTION unit missing setActionId)", () => {
    expect(() =>
      toBattleSimulationResponseBody(
        baseResult({
          finalState: {
            status: "COMPLETED",
            currentTurn: 1,
            result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
            units: {
              [ALLY_ID]: {
                hp: 90,
                ap: 1,
                pp: 0,
                extraGauge: 5,
                combatStats: ALLY_COMBAT_STATS,
                cooldowns: { [SKL_A]: { unit: "ACTION", remaining: 2 } },
              },
              [ENEMY_ID]: {
                hp: 0,
                ap: 0,
                pp: 0,
                extraGauge: 0,
                combatStats: ENEMY_COMBAT_STATS,
              },
            },
          },
        }),
      ),
    ).toThrow(/setActionId/);
  });

  it("API-RESP-010C (M5 review round 4 [P3] fix): throws instead of silently dropping the opposite-side scope field when a Domain cooldown has both setActionId and setTurnNumber set (unit ACTION with a stray setTurnNumber)", () => {
    expect(() =>
      toBattleSimulationResponseBody(
        baseResult({
          finalState: {
            status: "COMPLETED",
            currentTurn: 1,
            result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
            units: {
              [ALLY_ID]: {
                hp: 90,
                ap: 1,
                pp: 0,
                extraGauge: 5,
                combatStats: ALLY_COMBAT_STATS,
                cooldowns: {
                  [SKL_A]: {
                    unit: "ACTION",
                    remaining: 2,
                    setActionId: ACTION_1,
                    setTurnNumber: 3,
                  },
                },
              },
              [ENEMY_ID]: {
                hp: 0,
                ap: 0,
                pp: 0,
                extraGauge: 0,
                combatStats: ENEMY_COMBAT_STATS,
              },
            },
          },
        }),
      ),
    ).toThrow(/setTurnNumber/);
  });

  it("API-RESP-011 (P1 fix): maps a StateTransition's cooldowns delta into an EntityCollectionDelta (added/updated/removed derived from remaining crossing zero) and charge into a ValueChange with null for the unset side", () => {
    const body = toBattleSimulationResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  cooldowns: {
                    [SKL_A]: { unit: "ACTION", before: 0, after: 2, setActionId: ACTION_1 },
                    [SKL_B]: { unit: "TURN", before: 2, after: 1 },
                    [SKL_C]: { unit: "ACTION", before: 1, after: 0 },
                  },
                  charge: {
                    before: undefined,
                    after: { skillDefinitionId: SKL_D, startedActionId: ACTION_2 },
                  },
                },
              },
            },
          },
          {
            causedBySequence: 2,
            stateVersionBefore: 1,
            stateVersionAfter: 2,
            stateDelta: {
              units: {
                [ALLY_ID]: {
                  charge: {
                    before: { skillDefinitionId: SKL_D, startedActionId: ACTION_2 },
                    after: undefined,
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(body.stateTransitions[0]!.delta.units!["ally:1"]!.cooldowns).toEqual({
      added: [
        {
          skillDefinitionId: "SKL_A",
          unit: "ACTION",
          remaining: 2,
          setAtActionId: "action-1",
        },
      ],
      updated: [{ id: "SKL_B", before: 2, after: 1 }],
      removed: [{ id: "SKL_C", before: 1 }],
    });
    expect(body.stateTransitions[0]!.delta.units!["ally:1"]!.charge).toEqual({
      before: null,
      after: { skillDefinitionId: "SKL_D", startedActionId: "action-2", status: "CHARGING" },
    });
    expect(body.stateTransitions[1]!.delta.units!["ally:1"]!.charge).toEqual({
      before: { skillDefinitionId: "SKL_D", startedActionId: "action-2", status: "CHARGING" },
      after: null,
    });
  });

  it("API-RESP-010D (M5 review round 4 [P3] fix): CooldownStateResponseBody rejects a value with both setAtActionId and setAtTurnNumber at the type level, even through an intermediate variable (not just via excess-property-check on a literal)", () => {
    const both = {
      skillDefinitionId: "SKL_1",
      unit: "ACTION" as const,
      remaining: 1,
      setAtActionId: "a-1",
      setAtTurnNumber: 1,
    };

    // @ts-expect-error `setAtTurnNumber` is `never` on the ACTION variant, so this
    // assignment must fail even though `both` isn't an object literal (the
    // excess-property-check bypass the round 4 review found).
    const rejected: CooldownStateResponseBody = both;
    expect(rejected.unit).toBe("ACTION");
  });
});
