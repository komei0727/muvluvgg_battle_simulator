import { describe, expect, it } from "vitest";
import { assembleTacticalExerciseResult } from "./simulation-result-assembler.js";
import { ApplicationError } from "../contracts/application-error.js";
import type { LogLevel } from "./simulate-battle-command.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type {
  BattleStateSnapshot,
  BattleUnitRosterEntry,
} from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { createDomainEventId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId, type BattleUnitId } from "../../domain/shared/ids.js";
import {
  createUnitDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

const BATTLE_ID = createBattleId("battle-exercise-1");
const ENEMY_ID = createBattleUnitId("enemy:1");
/** ダメージ側の原因イベント（この投影テストでは記録しない）を指す固定ID。 */
const CAUSE_EVENT_ID = createDomainEventId("battle-exercise-1:cause");

/**
 * 演習の進行中（`RUNNING`）から記録を始める最小の初期状態。ターン進行そのものは
 * この投影テストの対象ではないため、`currentTurn`は終了ターンに固定し、記録する
 * 差分をスコア・ブレイク・結果確定だけに絞る。
 */
const COMPLETED_TURN = 5;
const INITIAL_STATE: BattleStateSnapshot = {
  status: "RUNNING",
  currentTurn: COMPLETED_TURN,
  units: {},
  exercise: { totalScore: 0, breakCount: 0 },
};

const COMBAT_STATS = {
  maximumHp: 100,
  attack: 10,
  defense: 10,
  criticalRate: 0,
  actionSpeed: 10,
  criticalDamageBonus: 0,
  affinityBonus: 0,
};

/** ロースター項目に対応する、可変状態を動かさない静止スナップショット。 */
function unitSnapshot() {
  return {
    hp: 100,
    ap: 1,
    pp: 0,
    extraGauge: 0,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
    combatStats: COMBAT_STATS,
    baseCombatStats: COMBAT_STATS,
  };
}

/** ブレイク発生源の定義ID解決だけに要る最小のロースター項目。 */
function rosterEntry(
  battleUnitId: BattleUnitId,
  unitDefinitionId: UnitDefinitionId,
): BattleUnitRosterEntry {
  return {
    battleUnitId,
    unitDefinitionId,
    side: "ALLY",
    position: { column: "LEFT", row: "FRONT" },
    globalCoordinate: { x: 0, y: 3 },
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0,
      affinityBonus: 0,
    },
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  };
}

/**
 * 演習1回ぶんのイベント列を組み立てる。`amounts`のスコア加算と`breakTurns`の
 * ブレイクを交互に記録し、最後に演習結果（R-TEX-10 #1）を確定する。
 */
function recordExercise(options: {
  readonly steps: readonly (
    | { readonly kind: "SCORE"; readonly amount: number; readonly turnNumber: number }
    | {
        readonly kind: "BREAK";
        readonly turnNumber: number;
        /** R-TEX-03 #2の発生源。省略時はメモリー由来（`sourceUnitId`なし）を表す。 */
        readonly sourceUnitId?: BattleUnitId;
      }
  )[];
  readonly completedTurn?: number;
}): { readonly recorder: EventRecorder; readonly finalState: BattleStateSnapshot } {
  const recorder = new EventRecorder(BATTLE_ID);
  let totalScore = 0;
  let breakCount = 0;
  for (const step of options.steps) {
    if (step.kind === "SCORE") {
      const before = totalScore;
      totalScore += step.amount;
      recorder.record({
        eventType: "ExerciseScoreAccumulated",
        category: "FACT",
        turnNumber: step.turnNumber,
        cycleNumber: 1,
        resolutionScopeId: recorder.nextResolutionScopeId(),
        payload: {
          targetUnitId: ENEMY_ID,
          amount: step.amount,
          totalScore,
          causeEventId: CAUSE_EVENT_ID,
        },
        stateDelta: { exercise: { totalScore: { before, after: totalScore } } },
      });
      continue;
    }
    const before = breakCount;
    breakCount += 1;
    recorder.record({
      eventType: "UnitBroken",
      category: "FACT",
      turnNumber: step.turnNumber,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: {
        unitId: ENEMY_ID,
        breakNumber: breakCount,
        turnNumber: step.turnNumber,
        totalScore,
        causeEventId: CAUSE_EVENT_ID,
        ...(step.sourceUnitId !== undefined ? { sourceUnitId: step.sourceUnitId } : {}),
        sourceSide: "ALLY" as const,
      },
      stateDelta: { exercise: { breakCount: { before, after: breakCount } } },
    });
  }

  const completedTurn = options.completedTurn ?? COMPLETED_TURN;
  const result = {
    completionReason: "TURN_LIMIT_REACHED" as const,
    completedTurn,
    totalScore,
    breakCount,
  };
  recorder.record({
    eventType: "BattleCompleted",
    category: "FACT",
    turnNumber: completedTurn,
    cycleNumber: 1,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: result,
    stateDelta: {
      battleStatus: { before: "RUNNING", after: "COMPLETED" },
      result: { before: undefined, after: result },
    },
  });

  return {
    recorder,
    finalState: {
      status: "COMPLETED",
      currentTurn: completedTurn,
      units: {},
      exercise: { totalScore, breakCount },
      result,
    },
  };
}

function assemble(
  options: Parameters<typeof recordExercise>[0] & {
    readonly logLevel?: LogLevel;
    readonly unitRoster?: readonly BattleUnitRosterEntry[];
  },
) {
  const { recorder, finalState } = recordExercise(options);
  // ロースターに載せたユニットは状態スナップショットにも居なければならない
  // （`unit-battle-summary-projector.ts`が対応を要求する）。この投影テストは
  // ユニットの可変状態を動かさないため、初期・最終とも同じ静止スナップショットにする。
  const unitStates = Object.fromEntries(
    (options.unitRoster ?? []).map((entry) => [entry.battleUnitId, unitSnapshot()]),
  );
  return assembleTacticalExerciseResult({
    battleId: BATTLE_ID,
    catalogRevision: "rev-1",
    logLevel: options.logLevel ?? "DETAILED",
    result: finalState.result as {
      readonly completionReason: "TURN_LIMIT_REACHED";
      readonly completedTurn: number;
      readonly totalScore: number;
      readonly breakCount: number;
    },
    initialState: { ...INITIAL_STATE, units: unitStates },
    finalState: { ...finalState, units: unitStates },
    events: recorder.getEvents(),
    unitRoster: options.unitRoster ?? [],
  });
}

describe("assembleTacticalExerciseResult", () => {
  it("UT-TEXASSEMBLER-001 (R-TEX-10 #1): packages the exercise result fields without an outcome", () => {
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 30, turnNumber: 1 },
        { kind: "SCORE", amount: 12, turnNumber: 2 },
      ],
    });

    expect(result.battleId).toBe(BATTLE_ID);
    expect(result.catalogRevision).toBe("rev-1");
    expect(result.completionReason).toBe("TURN_LIMIT_REACHED");
    expect(result.completedTurn).toBe(5);
    expect(result.totalScore).toBe(42);
    expect(result.breakCount).toBe(0);
    expect(result).not.toHaveProperty("outcome");
  });

  it("UT-TEXASSEMBLER-002 (R-TEX-10 #2): projects breaks from UnitBroken in occurrence order, carrying breakNumber, turnNumber and the cumulative score at that break", () => {
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 100, turnNumber: 1 },
        { kind: "BREAK", turnNumber: 1 },
        { kind: "SCORE", amount: 40, turnNumber: 3 },
        { kind: "BREAK", turnNumber: 3 },
        { kind: "SCORE", amount: 5, turnNumber: 4 },
      ],
    });

    expect(result.breaks).toEqual([
      { breakNumber: 1, turnNumber: 1, cumulativeScoreAtBreak: 100 },
      { breakNumber: 2, turnNumber: 3, cumulativeScoreAtBreak: 140 },
    ]);
    expect(result.breakCount).toBe(2);
    expect(result.breaks).toHaveLength(result.breakCount);
    expect(result.totalScore).toBe(145);
  });

  it("UT-TEXASSEMBLER-003 (R-TEX-10 #2): projects breaks from the events before the log-level filter, so SUMMARY keeps the full break history", () => {
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 10, turnNumber: 1 },
        { kind: "BREAK", turnNumber: 1 },
        { kind: "SCORE", amount: 20, turnNumber: 2 },
        { kind: "BREAK", turnNumber: 2 },
      ],
      logLevel: "SUMMARY",
    });

    expect(result.breaks.map((entry) => entry.breakNumber)).toEqual([1, 2]);
    expect(result.breaks).toHaveLength(result.breakCount);
    expect(result.totalScore).toBe(30);
    // SUMMARYはイベントも状態差分も1件も公開しないが、投影も総スコアも影響を受けない
    // ——`breaks`の投影元が間引き前の全イベントだからである。
    expect(result.events).toEqual([]);
    expect(result.stateTransitions).toEqual([]);
    expect(result.finalState).toBeUndefined();
  });

  it("UT-TEXASSEMBLER-004 (R-TEX-10 #2): returns an empty break history when the enemy never broke", () => {
    const result = assemble({
      steps: [{ kind: "SCORE", amount: 7, turnNumber: 1 }],
    });

    expect(result.breaks).toEqual([]);
    expect(result.breakCount).toBe(0);
  });

  it("UT-TEXASSEMBLER-008 (R-TEX-10 #2): resolves the break's source unit to its definition id through the roster", () => {
    const attackerId = createBattleUnitId("ally:1");
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 100, turnNumber: 1 },
        { kind: "BREAK", turnNumber: 1, sourceUnitId: attackerId },
      ],
      unitRoster: [rosterEntry(attackerId, createUnitDefinitionId("UNIT_KOTOHA_REBEL"))],
    });

    expect(result.breaks).toEqual([
      {
        breakNumber: 1,
        turnNumber: 1,
        cumulativeScoreAtBreak: 100,
        sourceUnitId: attackerId,
        sourceUnitDefinitionId: createUnitDefinitionId("UNIT_KOTOHA_REBEL"),
      },
    ]);
  });

  it("UT-TEXASSEMBLER-013 (R-FRM-03): keeps the source participation slot distinguishable when two slots share one definition id", () => {
    const firstSlotId = createBattleUnitId("ally:1");
    const secondSlotId = createBattleUnitId("ally:2");
    const sharedDefinitionId = createUnitDefinitionId("UNIT_KOTOHA_REBEL");
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 100, turnNumber: 1 },
        { kind: "BREAK", turnNumber: 1, sourceUnitId: secondSlotId },
      ],
      unitRoster: [
        rosterEntry(firstSlotId, sharedDefinitionId),
        rosterEntry(secondSlotId, sharedDefinitionId),
      ],
    });

    expect(result.breaks[0]?.sourceUnitId).toBe(secondSlotId);
  });

  it("UT-TEXASSEMBLER-009 (R-TEX-10 #2／R-MEM-04): omits the source unit for a break with no source unit, such as a Memory-derived continuous damage", () => {
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 40, turnNumber: 2 },
        { kind: "BREAK", turnNumber: 2 },
      ],
    });

    expect(result.breaks).toEqual([{ breakNumber: 1, turnNumber: 2, cumulativeScoreAtBreak: 40 }]);
    expect(result.breaks[0]).not.toHaveProperty("sourceUnitId");
    expect(result.breaks[0]).not.toHaveProperty("sourceUnitDefinitionId");
  });

  it("UT-TEXASSEMBLER-010 (R-TEX-10 #2): rejects a break whose source unit is missing from the roster instead of silently reporting it as source-less", () => {
    const unknownId = createBattleUnitId("ally:absent");
    const input = {
      steps: [
        { kind: "SCORE" as const, amount: 100, turnNumber: 1 },
        { kind: "BREAK" as const, turnNumber: 1, sourceUnitId: unknownId },
      ],
      unitRoster: [],
    };

    expect(() => assemble(input)).toThrow(ApplicationError);
    try {
      assemble(input);
    } catch (error) {
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-TEXASSEMBLER-005 (R-TEX-10 #3): verifies state restoration over the exercise deltas, so initialState + every delta equals finalState", () => {
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 60, turnNumber: 1 },
        { kind: "BREAK", turnNumber: 1 },
      ],
    });

    expect(result.finalState!.exercise).toEqual({ totalScore: 60, breakCount: 1 });
    expect(result.totalScore).toBe(60);
  });
});

describe("assembleTacticalExerciseResult break enhancement restoration (R-TEX-04)", () => {
  const BASE_STATS = {
    maximumHp: 100,
    attack: 10,
    defense: 10,
    criticalRate: 0,
    actionSpeed: 10,
    criticalDamageBonus: 0.5,
    affinityBonus: 0,
  };
  const ENHANCED_STATS = { ...BASE_STATS, maximumHp: 120, attack: 12 };

  function enemySnapshot(
    stats: typeof BASE_STATS,
    hp: number,
  ): BattleStateSnapshot["units"][BattleUnitId] {
    return {
      hp,
      ap: 0,
      pp: 0,
      extraGauge: 0,
      maximumAp: 3,
      maximumPp: 3,
      maximumExtraGauge: 100,
      combatStats: stats,
      baseCombatStats: stats,
    };
  }

  /**
   * ブレイク→復活を1回だけ記録する。`omitStatsDelta`を立てると、`UnitRevived`が
   * 所有すべき`units.<id>.baseCombatStats`／`combatStats`差分だけを落とす
   * （＝強化を状態差分として運び忘れた実装のバグを再現する）。
   */
  function assembleRevival(options: { readonly omitStatsDelta?: boolean } = {}) {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "UnitBroken",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: {
        unitId: ENEMY_ID,
        breakNumber: 1,
        turnNumber: 1,
        totalScore: 0,
        causeEventId: CAUSE_EVENT_ID,
      },
      stateDelta: { exercise: { breakCount: { before: 0, after: 1 } } },
    });
    const statsDelta = {
      baseCombatStats: {
        maximumHp: { before: BASE_STATS.maximumHp, after: ENHANCED_STATS.maximumHp },
        attack: { before: BASE_STATS.attack, after: ENHANCED_STATS.attack },
      },
      combatStats: {
        maximumHp: { before: BASE_STATS.maximumHp, after: ENHANCED_STATS.maximumHp },
        attack: { before: BASE_STATS.attack, after: ENHANCED_STATS.attack },
      },
    };
    recorder.record({
      eventType: "UnitRevived",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: {
        unitId: ENEMY_ID,
        breakNumber: 1,
        hpAfter: ENHANCED_STATS.maximumHp,
        baseCombatStats: ENHANCED_STATS,
      },
      stateDelta: {
        units: {
          [ENEMY_ID]: {
            hp: { before: 0, after: ENHANCED_STATS.maximumHp },
            ...(options.omitStatsDelta === true ? {} : statsDelta),
          },
        },
      },
    });

    const result = {
      completionReason: "TURN_LIMIT_REACHED" as const,
      completedTurn: COMPLETED_TURN,
      totalScore: 0,
      breakCount: 1,
    };
    recorder.record({
      eventType: "BattleCompleted",
      category: "FACT",
      turnNumber: COMPLETED_TURN,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: result,
      stateDelta: {
        battleStatus: { before: "RUNNING", after: "COMPLETED" },
        result: { before: undefined, after: result },
      },
    });

    return assembleTacticalExerciseResult({
      battleId: BATTLE_ID,
      catalogRevision: "rev-1",
      logLevel: "DETAILED",
      result,
      // HP0到達（ダメージ側のイベントが所有する差分）まで進んだ地点から記録を
      // 始める。ここで検証したいのは、そこから先の復活が運ぶ強化差分だけである。
      initialState: {
        ...INITIAL_STATE,
        units: { [ENEMY_ID]: enemySnapshot(BASE_STATS, 0) },
      },
      finalState: {
        status: "COMPLETED",
        currentTurn: COMPLETED_TURN,
        units: { [ENEMY_ID]: enemySnapshot(ENHANCED_STATS, ENHANCED_STATS.maximumHp) },
        exercise: { totalScore: 0, breakCount: 1 },
        result,
      },
      events: recorder.getEvents(),
      unitRoster: [],
    });
  }

  it("UT-TEXASSEMBLER-006 (R-TEX-04 #4): accepts a revival whose baseCombatStats/combatStats deltas restore the enhanced stats of finalState", () => {
    const result = assembleRevival();

    expect(result.finalState!.units[ENEMY_ID]?.baseCombatStats).toEqual(ENHANCED_STATS);
    expect(result.breaks).toEqual([{ breakNumber: 1, turnNumber: 1, cumulativeScoreAtBreak: 0 }]);
  });

  it("UT-TEXASSEMBLER-007 (R-TEX-04 #4): rejects a revival that changed the enhanced stats without carrying the baseCombatStats/combatStats deltas, because the restored state no longer matches finalState", () => {
    expect(() => assembleRevival({ omitStatsDelta: true })).toThrow(ApplicationError);
    try {
      assembleRevival({ omitStatsDelta: true });
    } catch (error) {
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });
});
