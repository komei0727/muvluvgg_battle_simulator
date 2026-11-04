import { describe, expect, it } from "vitest";
import { assembleTotalWarResult } from "./simulation-result-assembler.js";
import { ApplicationError } from "../contracts/application-error.js";
import type { LogLevel } from "./simulate-battle-command.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type {
  BattleStateSnapshot,
  BattleUnitRosterEntry,
  BattleUnitSnapshot,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type {
  StateDelta,
  TotalWarBattleResultSnapshot,
} from "../../domain/battle/events/state-delta.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import type { Side } from "../../domain/shared/side.js";

const BATTLE_ID = createBattleId("battle-total-war-1");
const ALLY_1 = createBattleUnitId("ally:1");
const ALLY_2 = createBattleUnitId("ally:2");
const ENEMY_1 = createBattleUnitId("enemy:1");
const ENEMY_2 = createBattleUnitId("enemy:2");

const COMBAT_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0,
  affinityBonus: 0,
  subAffinityBonus: 0,
};

function unitSnapshot(hp = 100): BattleUnitSnapshot {
  return {
    hp,
    ap: 0,
    pp: 0,
    extraGauge: 0,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
    combatStats: COMBAT_STATS,
    baseCombatStats: COMBAT_STATS,
  };
}

function rosterEntry(
  battleUnitId: BattleUnitId,
  side: Side,
  formationNumber: number,
): BattleUnitRosterEntry {
  return {
    battleUnitId,
    unitDefinitionId: createUnitDefinitionId("UNIT_TEST"),
    side,
    position: { column: "CENTER", row: "FRONT" },
    globalCoordinate: { x: 1, y: side === "ALLY" ? 3 : 0 },
    combatStats: COMBAT_STATS,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
    formationNumber,
  };
}

/** 各陣営2編成。味方の2番目の編成は出撃せずに終わる。 */
const ROSTER: readonly BattleUnitRosterEntry[] = [
  rosterEntry(ALLY_1, "ALLY", 1),
  rosterEntry(ALLY_2, "ALLY", 2),
  rosterEntry(ENEMY_1, "ENEMY", 1),
  rosterEntry(ENEMY_2, "ENEMY", 2),
];

const INITIAL_STATE: BattleStateSnapshot = {
  status: "RUNNING",
  currentTurn: 1,
  units: { [ALLY_1]: unitSnapshot(), [ENEMY_1]: unitSnapshot() },
  formations: {
    ALLY: { formationCount: 2, activeFormationNumber: 1, defeatedCount: 0 },
    ENEMY: { formationCount: 2, activeFormationNumber: 1, defeatedCount: 0 },
  },
};

const RESULT: TotalWarBattleResultSnapshot = {
  outcome: "DRAW",
  completionReason: "TURN_LIMIT_REACHED",
  completedTurn: 2,
  stages: [
    {
      stageNumber: 1,
      allyFormationNumber: 1,
      enemyFormationNumber: 1,
      startTurn: 1,
      endTurn: 1,
      defeatedSides: ["ENEMY"],
    },
    {
      stageNumber: 2,
      allyFormationNumber: 1,
      enemyFormationNumber: 2,
      startTurn: 2,
      endTurn: 2,
      defeatedSides: [],
    },
  ],
  defeatedFormationCounts: { ally: 0, enemy: 1 },
};

function recordDamage(
  recorder: EventRecorder,
  turnNumber: number,
  targetUnitId: BattleUnitId,
  hpBefore: number,
  hpAfter: number,
): void {
  const hitPointDamage = hpBefore - hpAfter;
  recorder.record({
    eventType: "DamageApplied",
    category: "FACT",
    turnNumber,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    sourceUnitId: ALLY_1,
    targetUnitIds: [targetUnitId],
    payload: {
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_TEST"),
      hitIndex: 1,
      targetUnitId,
      calculatedDamage: hitPointDamage,
      hpDirectDamage: 0,
      typedShieldAbsorbed: 0,
      untypedShieldAbsorbed: 0,
      subUnitAbsorbed: 0,
      discardedDamage: 0,
      hitPointDamage,
      hpBefore,
      hpAfter,
      defeated: hpAfter === 0,
      critical: false,
      attributeRelation: "NEUTRAL",
      damageType: "NORMAL",
    } as never,
    stateDelta: { units: { [targetUnitId]: { hp: { before: hpBefore, after: hpAfter } } } },
  });
}

/**
 * 敵の1番目の編成が1ターン目に全滅し、2ターン目の開始時に2番目の編成が出撃して、
 * 決着しないまま終わる総力戦のイベント列。`deployedDelta`で`FormationDeployed`の差分を差し替える。
 */
function recordTotalWar(
  options: { readonly deployedDelta?: StateDelta | null } = {},
): EventRecorder {
  const recorder = new EventRecorder(BATTLE_ID);
  recordDamage(recorder, 1, ENEMY_1, 100, 0);
  recorder.record({
    eventType: "FormationDefeated",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { side: "ENEMY", formationNumber: 1, turnNumber: 1, remainingReserveCount: 1 },
    stateDelta: { formations: { ENEMY: { defeatedCount: { before: 0, after: 1 } } } },
  });
  const deployedDelta =
    options.deployedDelta === undefined
      ? {
          addedUnits: { [ENEMY_2]: unitSnapshot() },
          formations: { ENEMY: { activeFormationNumber: { before: 1, after: 2 } } },
        }
      : options.deployedDelta;
  recorder.record({
    eventType: "FormationDeployed",
    category: "FACT",
    turnNumber: 2,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { side: "ENEMY", formationNumber: 2, turnNumber: 2, battleUnitIds: [ENEMY_2] },
    ...(deployedDelta !== null ? { stateDelta: deployedDelta } : {}),
  });
  recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 2,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 2 },
    stateDelta: { turnNumber: { before: 1, after: 2 } },
  });
  recordDamage(recorder, 2, ENEMY_2, 100, 40);
  recorder.record({
    eventType: "BattleCompleted",
    category: "FACT",
    turnNumber: 2,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: RESULT,
    stateDelta: {
      battleStatus: { before: "RUNNING", after: "COMPLETED" },
      result: { before: undefined, after: RESULT },
    },
  });
  return recorder;
}

const FINAL_STATE: BattleStateSnapshot = {
  status: "COMPLETED",
  currentTurn: 2,
  units: { [ALLY_1]: unitSnapshot(), [ENEMY_1]: unitSnapshot(0), [ENEMY_2]: unitSnapshot(40) },
  result: RESULT,
  formations: {
    ALLY: { formationCount: 2, activeFormationNumber: 1, defeatedCount: 0 },
    ENEMY: { formationCount: 2, activeFormationNumber: 2, defeatedCount: 1 },
  },
};

function assemble(
  options: {
    readonly recorder?: EventRecorder;
    readonly finalState?: BattleStateSnapshot;
    readonly logLevel?: LogLevel;
  } = {},
) {
  return assembleTotalWarResult({
    battleId: BATTLE_ID,
    catalogRevision: "rev-1",
    logLevel: options.logLevel ?? "DETAILED",
    result: RESULT,
    initialState: INITIAL_STATE,
    finalState: options.finalState ?? FINAL_STATE,
    events: (options.recorder ?? recordTotalWar()).getEvents(),
    unitRoster: ROSTER,
  });
}

function expectInvariantViolation(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    return;
  }
  expect.unreachable("expected INTERNAL_INVARIANT_VIOLATION");
}

describe("assembleTotalWarResult", () => {
  it("UT-TWASSEMBLER-001 [R-TWR-04]: restores the final state from the events, including the unit that joined mid-battle, and packages the total war result", () => {
    const result = assemble();

    expect(result).toMatchObject({
      outcome: "DRAW",
      completionReason: "TURN_LIMIT_REACHED",
      completedTurn: 2,
      stages: RESULT.stages,
      defeatedFormationCounts: { ally: 0, enemy: 1 },
      initialState: INITIAL_STATE,
      finalState: FINAL_STATE,
    });
    expect(result.stateTransitions).toHaveLength(6);
  });

  it("UT-TWASSEMBLER-002 [R-TWR-03]: lists every unit of every formation in the roster and the summaries with its formation number and whether it deployed", () => {
    const result = assemble();

    expect(
      result.unitRoster.map((entry) => [entry.battleUnitId, entry.formationNumber, entry.deployed]),
    ).toEqual([
      [ALLY_1, 1, true],
      [ALLY_2, 2, false],
      [ENEMY_1, 1, true],
      [ENEMY_2, 2, true],
    ]);
    expect(
      result.unitSummaries.map((summary) => [
        summary.battleUnitId,
        summary.formationNumber,
        summary.deployed,
        summary.damageTaken,
      ]),
    ).toEqual([
      [ALLY_1, 1, true, 0],
      [ALLY_2, 2, false, 0],
      [ENEMY_1, 1, true, 100],
      [ENEMY_2, 2, true, 60],
    ]);
  });

  it("UT-TWASSEMBLER-003 [R-TWR-04]: SUMMARY omits the final state and transitions but still returns the full roster and every unit's summary", () => {
    const result = assemble({ logLevel: "SUMMARY" });

    expect(result.finalState).toBeUndefined();
    expect(result.stateTransitions).toEqual([]);
    expect(result.unitRoster).toHaveLength(4);
    expect(result.unitSummaries).toHaveLength(4);
  });

  it("UT-TWASSEMBLER-004 [R-TWR-04]: rejects a deployment that does not add its units, since later deltas then target a unit absent from the restored state", () => {
    expectInvariantViolation(() =>
      assemble({
        recorder: recordTotalWar({
          deployedDelta: {
            formations: { ENEMY: { activeFormationNumber: { before: 1, after: 2 } } },
          },
        }),
      }),
    );
  });

  it("UT-TWASSEMBLER-005 [R-TWR-04]: rejects a final state whose formation state disagrees with the one restored from the deltas", () => {
    expectInvariantViolation(() =>
      assemble({
        recorder: recordTotalWar({ deployedDelta: { addedUnits: { [ENEMY_2]: unitSnapshot() } } }),
        finalState: FINAL_STATE,
      }),
    );
  });
});
