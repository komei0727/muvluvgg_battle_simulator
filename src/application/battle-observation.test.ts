import { describe, expect, it } from "vitest";
import { buildBattleObservation } from "./battle-observation.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");
const UNIT_A = createBattleUnitId("unit-a");

function recordSampleEvents(): readonly BattleDomainEvent[] {
  const recorder = new EventRecorder(BATTLE_ID);
  recorder.record({
    eventType: "BattleStarted",
    category: "FACT",
    turnNumber: 0,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
    stateDelta: { battleStatus: { before: "READY", after: "RUNNING" } },
  });
  const turnStarted = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
    stateDelta: { turnNumber: { before: 0, after: 1 } },
  });
  recorder.record({
    eventType: "TurnCompleting",
    category: "TIMING",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    parentEventId: turnStarted.eventId,
    rootEventId: turnStarted.eventId,
    payload: { turnNumber: 1 },
  });
  return recorder.getEvents();
}

describe("buildBattleObservation", () => {
  it("UT-BATTLE-OBSERVATION-001: preserves initialState, finalState, and the full event list unchanged", () => {
    const events = recordSampleEvents();
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    const finalState = { status: "COMPLETED" as const, currentTurn: 1, units: {} };

    const observation = buildBattleObservation({ initialState, finalState, events });

    expect(observation.initialState).toBe(initialState);
    expect(observation.finalState).toBe(finalState);
    expect(observation.events).toBe(events);
  });

  it("UT-BATTLE-OBSERVATION-002: projects only the events carrying a stateDelta into stateTransitions, preserving sequence order", () => {
    const events = recordSampleEvents();
    const initialState = { status: "READY" as const, currentTurn: 0, units: {} };
    const finalState = { status: "RUNNING" as const, currentTurn: 1, units: {} };

    const observation = buildBattleObservation({ initialState, finalState, events });

    expect(observation.stateTransitions).toHaveLength(2);
    expect(observation.stateTransitions[0]).toEqual({
      causedBySequence: 1,
      stateVersionBefore: 0,
      stateVersionAfter: 1,
      stateDelta: { battleStatus: { before: "READY", after: "RUNNING" } },
    });
    expect(observation.stateTransitions[1]).toEqual({
      causedBySequence: 2,
      stateVersionBefore: 1,
      stateVersionAfter: 2,
      stateDelta: { turnNumber: { before: 0, after: 1 } },
    });
  });

  it("UT-BATTLE-OBSERVATION-003 (SCN-BTL-021): reduceStateDeltas(initialState, stateTransitions.map(t => t.stateDelta)) reproduces finalState", async () => {
    const { reduceStateDeltas } = await import("../domain/battle/events/state-delta-reducer.js");
    const events = recordSampleEvents();
    const initialState = {
      status: "READY" as const,
      currentTurn: 0,
      units: { [UNIT_A]: { hp: 100, ap: 0, pp: 0, extraGauge: 0 } },
    };

    const observation = buildBattleObservation({
      initialState,
      finalState: { status: "RUNNING" as const, currentTurn: 1, units: initialState.units },
      events,
    });

    const restored = reduceStateDeltas(
      observation.initialState,
      observation.stateTransitions.map((t) => t.stateDelta),
    );

    expect(restored).toEqual(observation.finalState);
  });
});
