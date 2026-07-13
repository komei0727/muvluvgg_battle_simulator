import { describe, expect, it } from "vitest";
import { assembleSimulationResult } from "./simulation-result-assembler.js";
import { ApplicationError } from "./application-error.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createBattleId } from "../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");

function recordBattleStarted(recorder: EventRecorder): void {
  recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
    stateDelta: { battleStatus: { before: "READY", after: "RUNNING" } },
  });
}

/** BattleStarted(version 0->1) -> TurnStarted(version 1->2)の2件のstateDelta付きイベント。 */
function recordTwoDeltaEvents(recorder: EventRecorder): void {
  recordBattleStarted(recorder);
  recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
    stateDelta: { turnNumber: { before: 0, after: 1 } },
  });
}

function baseInput(events: readonly BattleDomainEvent[]) {
  return {
    battleId: BATTLE_ID,
    catalogRevision: "rev-1",
    logLevel: "DETAILED" as const,
    result: {
      outcome: "ALLY_WIN" as const,
      completionReason: "ENEMY_DEFEATED" as const,
      completedTurn: 3,
    },
    initialState: { status: "READY" as const, currentTurn: 0, units: {} },
    finalState: { status: "RUNNING" as const, currentTurn: 1, units: {} },
    events,
  };
}

describe("assembleSimulationResult", () => {
  it("UT-RESULT-ASSEMBLER-001: packages the battle outcome fields and initialState/finalState/events/stateTransitions at the top level (09_アプリケーション設計.md SimulateBattleResult)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder);
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    // Consistent with the single recorded delta (READY -> RUNNING only).
    const finalState = { status: "RUNNING" as const, currentTurn: 0, units: {} };

    const result = assembleSimulationResult({
      battleId: BATTLE_ID,
      catalogRevision: "rev-1",
      logLevel: "DETAILED",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      initialState,
      finalState,
      events: recorder.getEvents(),
    });

    expect(result.battleId).toBe(BATTLE_ID);
    expect(result.catalogRevision).toBe("rev-1");
    expect(result.outcome).toBe("ALLY_WIN");
    expect(result.completionReason).toBe("ENEMY_DEFEATED");
    expect(result.completedTurn).toBe(3);
    expect(result.initialState).toBe(initialState);
    expect(result.finalState).toBe(finalState);
    expect(result.events).toHaveLength(1);
    expect(result.stateTransitions).toHaveLength(1);
  });

  it("UT-RESULT-ASSEMBLER-002: throws INTERNAL_INVARIANT_VIOLATION when the given finalState does not match initialState + stateTransitions restored through the independent Reducer", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder);
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    // Only a READY -> RUNNING delta was recorded, so a finalState claiming
    // COMPLETED/turn 3 is inconsistent with the recorded event log.
    const finalState = { status: "COMPLETED" as const, currentTurn: 3, units: {} };

    expect(() =>
      assembleSimulationResult({
        battleId: BATTLE_ID,
        catalogRevision: "rev-1",
        logLevel: "DETAILED",
        result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
        initialState,
        finalState,
        events: recorder.getEvents(),
      }),
    ).toThrow(ApplicationError);
  });

  it("UT-RESULT-ASSEMBLER-007: filters events by logLevel (SUMMARY) while keeping stateTransitions complete", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder); // BattleStarted is SUMMARY-visible and carries the only delta.
    recorder.record({
      eventType: "TargetsSelected",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { skillDefinitionId: "SKL_1" as never, bindings: [] },
    });
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    const finalState = { status: "RUNNING" as const, currentTurn: 0, units: {} };

    const result = assembleSimulationResult({
      battleId: BATTLE_ID,
      catalogRevision: "rev-1",
      logLevel: "SUMMARY",
      result: { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED", completedTurn: 3 },
      initialState,
      finalState,
      events: recorder.getEvents(),
    });

    expect(result.events.map((e) => e.type)).toEqual(["BATTLE_STARTED"]);
    // stateTransitions is unaffected by logLevel: it stays complete either way.
    expect(result.stateTransitions).toHaveLength(1);
  });

  it("UT-RESULT-ASSEMBLER-003: converts a Reducer-detected broken delta sequence (DomainValidationError) into INTERNAL_INVARIANT_VIOLATION, not INVALID_COMMAND", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "BattleStarted",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
      // before ("RUNNING") does not match initialState.status ("READY"): the
      // independent Reducer rejects this as a DomainValidationError.
      stateDelta: { battleStatus: { before: "RUNNING", after: "COMPLETED" } },
    });

    try {
      assembleSimulationResult(baseInput(recorder.getEvents()));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-004: throws INTERNAL_INVARIANT_VIOLATION when a transition's stateVersionAfter skips ahead of stateVersionBefore + 1 (missing version)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordTwoDeltaEvents(recorder);
    const [battleStarted, turnStarted] = recorder.getEvents();
    const corrupted: readonly BattleDomainEvent[] = [
      battleStarted!,
      { ...turnStarted!, stateVersionBefore: 1, stateVersionAfter: 3 },
    ];

    try {
      assembleSimulationResult(baseInput(corrupted));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-005: throws INTERNAL_INVARIANT_VIOLATION when the first transition's stateVersionBefore is not 0 (reversed order)", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordTwoDeltaEvents(recorder);
    const [battleStarted, turnStarted] = recorder.getEvents();
    const reversed: readonly BattleDomainEvent[] = [turnStarted!, battleStarted!];

    try {
      assembleSimulationResult(baseInput(reversed));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });

  it("UT-RESULT-ASSEMBLER-006: throws INTERNAL_INVARIANT_VIOLATION when a stateVersion is duplicated across transitions", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recordBattleStarted(recorder);
    const [battleStarted] = recorder.getEvents();
    const duplicated: readonly BattleDomainEvent[] = [battleStarted!, battleStarted!];

    try {
      assembleSimulationResult(baseInput(duplicated));
      expect.fail("expected assembleSimulationResult to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INTERNAL_INVARIANT_VIOLATION");
    }
  });
});
