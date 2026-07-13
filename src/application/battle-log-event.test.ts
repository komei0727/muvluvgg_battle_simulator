import { describe, expect, it } from "vitest";
import { toBattleLogEvents } from "./battle-log-event.js";
import { EventRecorder } from "../domain/battle/events/event-recorder.js";
import { createBattleId } from "../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");

describe("toBattleLogEvents", () => {
  it("UT-LOG-EVENT-001 (08_ドメインイベント.md BattleLogEvent): converts eventType to an UPPER_SNAKE_CASE type", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "BattleStarted",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events);

    expect(logEvents[0]!.type).toBe("BATTLE_STARTED");
  });

  it("UT-LOG-EVENT-002: renames payload to details, passing the same content through unchanged", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "BattleStarted",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events);

    expect(logEvents[0]!.details).toEqual({
      turnLimit: 3,
      allySlotCount: 1,
      enemySlotCount: 1,
    });
    expect(logEvents[0]).not.toHaveProperty("payload");
  });

  it("UT-LOG-EVENT-003: resolves parentSequence from parentEventId by looking up the parent's own sequence, and omits eventId/parentEventId/rootEventId", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const scope = recorder.nextResolutionScopeId();
    const turnStarted = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });
    recorder.record({
      eventType: "ResourcesRecovered",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      parentEventId: turnStarted.eventId,
      rootEventId: turnStarted.eventId,
      payload: { units: [] },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events);

    expect(logEvents[0]!.parentSequence).toBeUndefined();
    expect(logEvents[1]!.parentSequence).toBe(logEvents[0]!.sequence);
    expect(logEvents[1]).not.toHaveProperty("parentEventId");
    expect(logEvents[1]).not.toHaveProperty("rootEventId");
    expect(logEvents[1]).not.toHaveProperty("eventId");
  });

  it("UT-LOG-EVENT-004: resolves parentSequence against the full event set even when the parent itself was filtered out of the visible subset", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const scope = recorder.nextResolutionScopeId();
    const turnStarted = recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });
    const resourcesRecovered = recorder.record({
      eventType: "ResourcesRecovered",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      parentEventId: turnStarted.eventId,
      rootEventId: turnStarted.eventId,
      payload: { units: [] },
    });
    const allEvents = recorder.getEvents();
    const visibleOnly = [resourcesRecovered];

    const logEvents = toBattleLogEvents(visibleOnly, allEvents);

    expect(logEvents).toHaveLength(1);
    expect(logEvents[0]!.parentSequence).toBe(turnStarted.sequence);
  });

  it("UT-LOG-EVENT-005: sets stateTransitionReference to the event's own sequence when it carries a stateDelta, and omits it otherwise", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "TurnStarted",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });
    recorder.record({
      eventType: "BattleStarted",
      category: "FACT",
      turnNumber: 0,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnLimit: 3, allySlotCount: 1, enemySlotCount: 1 },
      stateDelta: { battleStatus: { before: "READY", after: "RUNNING" } },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events);

    expect(logEvents[0]!.stateTransitionReference).toBeUndefined();
    expect(logEvents[1]!.stateTransitionReference).toBe(logEvents[1]!.sequence);
  });

  it("UT-LOG-EVENT-006: does not duplicate stateDelta content on the event itself (available only via stateTransitions, joined by stateTransitionReference)", () => {
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
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events);

    expect(logEvents[0]).not.toHaveProperty("stateDelta");
  });

  it("UT-LOG-EVENT-007: passes actionId/sourceUnitId/targetUnitIds through unchanged when present", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const actionId = recorder.nextActionId();
    recorder.record({
      eventType: "ActionStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: "ally:1" as never,
      targetUnitIds: ["enemy:1" as never],
      payload: {
        actorUnitId: "ally:1" as never,
        reservedActionType: "AS",
        effectiveActionType: "AS",
        apBefore: 1,
        apAfter: 0,
        exBefore: 0,
        exAfter: 0,
      },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events);

    expect(logEvents[0]!.actionId).toBe(actionId);
    expect(logEvents[0]!.sourceUnitId).toBe("ally:1");
    expect(logEvents[0]!.targetUnitIds).toEqual(["enemy:1"]);
  });

  it("UT-LOG-EVENT-008: carries stateVersionBefore/stateVersionAfter through unchanged", () => {
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
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events);

    expect(logEvents[0]!.stateVersionBefore).toBe(0);
    expect(logEvents[0]!.stateVersionAfter).toBe(1);
  });
});
