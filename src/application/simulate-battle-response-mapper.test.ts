import { describe, expect, it } from "vitest";
import { toBattleSimulationResponseBody } from "./simulate-battle-response-mapper.js";
import type { SimulateBattleResult } from "./simulation-result-assembler.js";
import { createUnitDefinitionId } from "../domain/catalog/catalog-ids.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");
const ALLY_ID = createBattleUnitId("ally:1");
const ENEMY_ID = createBattleUnitId("enemy:1");

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
        [ALLY_ID]: { hp: 100, ap: 0, pp: 0, extraGauge: 0 },
        [ENEMY_ID]: { hp: 100, ap: 0, pp: 0, extraGauge: 0 },
      },
    },
    finalState: {
      status: "COMPLETED",
      currentTurn: 1,
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 1 },
      units: {
        [ALLY_ID]: { hp: 90, ap: 1, pp: 0, extraGauge: 5 },
        [ENEMY_ID]: { hp: 0, ap: 0, pp: 0, extraGauge: 0 },
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
        combatStats: {
          maximumHp: 100,
          attack: 10,
          defense: 10,
          criticalRate: 5,
          actionSpeed: 10,
          criticalDamageBonus: 50,
          affinityBonus: 0,
        },
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
        combatStats: {
          maximumHp: 100,
          attack: 8,
          defense: 8,
          criticalRate: 5,
          actionSpeed: 8,
          criticalDamageBonus: 50,
          affinityBonus: 0,
        },
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

  it("API-RESP-006: includes real combatStats from the roster and truthfully-empty shields/subUnits/effects/cooldowns (no shield/effect mechanic exists yet)", () => {
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
});
