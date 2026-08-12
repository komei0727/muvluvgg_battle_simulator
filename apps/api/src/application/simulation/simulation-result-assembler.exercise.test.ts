import { describe, expect, it } from "vitest";
import { assembleTacticalExerciseResult } from "./simulation-result-assembler.js";
import type { LogLevel } from "./simulate-battle-command.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import { createDomainEventId } from "../../domain/shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../domain/shared/ids.js";

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

/**
 * 演習1回ぶんのイベント列を組み立てる。`amounts`のスコア加算と`breakTurns`の
 * ブレイクを交互に記録し、最後に演習結果（R-TEX-10 #1）を確定する。
 */
function recordExercise(options: {
  readonly steps: readonly (
    | { readonly kind: "SCORE"; readonly amount: number; readonly turnNumber: number }
    | { readonly kind: "BREAK"; readonly turnNumber: number }
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
  options: Parameters<typeof recordExercise>[0] & { readonly logLevel?: LogLevel },
) {
  const { recorder, finalState } = recordExercise(options);
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
    initialState: INITIAL_STATE,
    finalState,
    events: recorder.getEvents(),
    unitRoster: [],
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
    // SUMMARYはスコア加算イベントを公開しないが、投影も総スコアも影響を受けない。
    expect(result.events.some((event) => event.type === "EXERCISE_SCORE_ACCUMULATED")).toBe(false);
    expect(result.stateTransitions.length).toBeGreaterThan(result.events.length);
  });

  it("UT-TEXASSEMBLER-004 (R-TEX-10 #2): returns an empty break history when the enemy never broke", () => {
    const result = assemble({
      steps: [{ kind: "SCORE", amount: 7, turnNumber: 1 }],
    });

    expect(result.breaks).toEqual([]);
    expect(result.breakCount).toBe(0);
  });

  it("UT-TEXASSEMBLER-005 (R-TEX-10 #3): verifies state restoration over the exercise deltas, so initialState + every delta equals finalState", () => {
    const result = assemble({
      steps: [
        { kind: "SCORE", amount: 60, turnNumber: 1 },
        { kind: "BREAK", turnNumber: 1 },
      ],
    });

    expect(result.finalState.exercise).toEqual({ totalScore: 60, breakCount: 1 });
    expect(result.totalScore).toBe(60);
  });
});
