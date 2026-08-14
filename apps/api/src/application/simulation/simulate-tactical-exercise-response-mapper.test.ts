import { describe, expect, it } from "vitest";
import { toTacticalExerciseResponseBody } from "./simulate-tactical-exercise-response-mapper.js";
import type { SimulateTacticalExerciseResult } from "./simulation-result-assembler.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-exercise-1");
const ALLY_ID = createBattleUnitId("ally:1");
const ENEMY_ID = createBattleUnitId("enemy:1");

// R-NUM-01: 割合はDomain内部で1.0=100%として保持する。
const COMBAT_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0.05,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0,
};

function unitSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    hp: 100,
    ap: 0,
    pp: 0,
    extraGauge: 0,
    maximumAp: 3,
    maximumPp: 2,
    maximumExtraGauge: 100,
    combatStats: COMBAT_STATS,
    baseCombatStats: COMBAT_STATS,
    ...overrides,
  };
}

function baseResult(
  overrides: Partial<SimulateTacticalExerciseResult> = {},
): SimulateTacticalExerciseResult {
  return {
    battleId: BATTLE_ID,
    catalogRevision: "rev-1",
    completionReason: "TURN_LIMIT_REACHED",
    completedTurn: 5,
    totalScore: 1200,
    breakCount: 2,
    breaks: [
      { breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 500 },
      { breakNumber: 2, turnNumber: 4, cumulativeScoreAtBreak: 900 },
    ],
    initialState: {
      status: "READY",
      currentTurn: 0,
      units: { [ALLY_ID]: unitSnapshot(), [ENEMY_ID]: unitSnapshot() },
      exercise: { totalScore: 0, breakCount: 0 },
    },
    finalState: {
      status: "COMPLETED",
      currentTurn: 5,
      units: { [ALLY_ID]: unitSnapshot(), [ENEMY_ID]: unitSnapshot() },
      exercise: { totalScore: 1200, breakCount: 2 },
    },
    events: [],
    stateTransitions: [],
    unitSummaries: [
      {
        battleUnitId: ALLY_ID,
        side: "ALLY",
        damageDealt: 640,
        damageTaken: 55,
        healingDone: 30,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
      {
        battleUnitId: ENEMY_ID,
        side: "ENEMY",
        damageDealt: 55,
        damageTaken: 640,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
    ],
    unitRoster: [
      {
        battleUnitId: ALLY_ID,
        unitDefinitionId: createUnitDefinitionId("UNIT_ALLY"),
        side: "ALLY",
        position: { column: "LEFT", row: "FRONT" },
        globalCoordinate: { x: 0, y: 2 },
        combatStats: COMBAT_STATS,
        maximumAp: 3,
        maximumPp: 2,
        maximumExtraGauge: 100,
      },
      {
        battleUnitId: ENEMY_ID,
        unitDefinitionId: createUnitDefinitionId("UNIT_ENEMY"),
        side: "ENEMY",
        position: { column: "LEFT", row: "FRONT" },
        globalCoordinate: { x: 0, y: 1 },
        combatStats: COMBAT_STATS,
        maximumAp: 3,
        maximumPp: 2,
        maximumExtraGauge: 100,
      },
    ],
    ...overrides,
  };
}

describe("toTacticalExerciseResponseBody (10_API設計.md「TacticalExerciseResponse」)", () => {
  it("API-TEXRESP-001 (R-TEX-10 #1): publishes the exercise result — completionReason/completedTurn/totalScore/breakCount/breaks — and no outcome", () => {
    const body = toTacticalExerciseResponseBody(baseResult());

    expect(body.schemaVersion).toBe(1);
    expect(body.battleId).toBe("battle-exercise-1");
    expect(body.catalogRevision).toBe("rev-1");
    expect(body.result).toEqual({
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 5,
      totalScore: 1200,
      breakCount: 2,
      breaks: [
        { breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 500 },
        { breakNumber: 2, turnNumber: 4, cumulativeScoreAtBreak: 900 },
      ],
    });
    expect(body.result).not.toHaveProperty("outcome");
  });

  it("API-TEXRESP-002: reuses the battle response's state/event/transition shape, so initialState is stateVersion 0 and finalState carries the last transition's stateVersionAfter", () => {
    const body = toTacticalExerciseResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: { turnNumber: { before: 0, after: 1 } },
          },
        ],
      }),
    );

    expect(body.initialState.stateVersion).toBe(0);
    expect(body.finalState!.stateVersion).toBe(1);
    expect(body.initialState.units.map((unit) => unit.battleUnitId)).toEqual(["ally:1", "enemy:1"]);
    expect(body.stateTransitions[0]?.delta.battle).toEqual({ turnNumber: { before: 0, after: 1 } });
  });

  it("API-TEXRESP-003 (R-TEX-02/03、10_API設計.md「BattleStateDeltaResponse」): publishes the exercise state delta (totalScore/breakCount) that only a tactical exercise produces", () => {
    const body = toTacticalExerciseResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: { exercise: { totalScore: { before: 0, after: 500 } } },
          },
          {
            causedBySequence: 2,
            stateVersionBefore: 1,
            stateVersionAfter: 2,
            stateDelta: { exercise: { breakCount: { before: 0, after: 1 } } },
          },
        ],
      }),
    );

    expect(body.stateTransitions[0]?.delta.exercise).toEqual({
      totalScore: { before: 0, after: 500 },
    });
    expect(body.stateTransitions[1]?.delta.exercise).toEqual({
      breakCount: { before: 0, after: 1 },
    });
  });

  it("API-TEXRESP-004 (R-TEX-04、10_API設計.md「UnitStateDeltaResponse」): publishes UnitRevived's baseCombatStats delta as raw ratios — it has no published state to apply to, so it matches UNIT_REVIVED.details rather than CombatStatsResponse's percentage points", () => {
    const body = toTacticalExerciseResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: {
              units: {
                [ENEMY_ID]: {
                  baseCombatStats: {
                    maximumHp: { before: 100, after: 130 },
                    attack: { before: 10, after: 13 },
                    criticalRate: { before: 0.05, after: 0.065 },
                  },
                  combatStats: {
                    attack: { before: 10, after: 13 },
                    criticalRate: { before: 0.05, after: 0.065 },
                  },
                },
              },
            },
          },
        ],
      }),
    );

    const unitDelta = body.stateTransitions[0]?.delta.units?.["enemy:1"];
    expect(unitDelta?.baseCombatStats).toEqual({
      maximumHp: { before: 100, after: 130 },
      attack: { before: 10, after: 13 },
      criticalRate: { before: 0.05, after: 0.065 },
    });
    // 実効値側は従来どおりパーセントポイントで公開し、`maximumHp`は`hpMaximum`が運ぶ。
    expect(unitDelta?.combatStats).toEqual({
      attack: { before: 10, after: 13 },
      criticalRate: { before: 5, after: 6.5 },
    });
  });

  it("API-TEXRESP-005: omits exercise and baseCombatStats from a delta that carries neither, so a normal-battle-shaped delta is published unchanged", () => {
    const body = toTacticalExerciseResponseBody(
      baseResult({
        stateTransitions: [
          {
            causedBySequence: 1,
            stateVersionBefore: 0,
            stateVersionAfter: 1,
            stateDelta: { units: { [ALLY_ID]: { hp: { before: 100, after: 90 } } } },
          },
        ],
      }),
    );

    const delta = body.stateTransitions[0]?.delta;
    expect(delta).not.toHaveProperty("exercise");
    expect(delta?.units?.["ally:1"]).not.toHaveProperty("baseCombatStats");
  });

  it("API-TEXRESP-006 (10_API設計.md「UnitBattleSummaryResponse」): publishes unitSummaries in Result order, using the same conversion as the battle endpoint", () => {
    const body = toTacticalExerciseResponseBody(baseResult());

    expect(body.unitSummaries).toEqual([
      {
        battleUnitId: "ally:1",
        side: "ALLY",
        damageDealt: 640,
        damageTaken: 55,
        healingDone: 30,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
      {
        battleUnitId: "enemy:1",
        side: "ENEMY",
        damageDealt: 55,
        damageTaken: 640,
        healingDone: 0,
        finalHp: 100,
        maximumHp: 100,
        combatStatus: "ACTIVE",
      },
    ]);
  });
});
