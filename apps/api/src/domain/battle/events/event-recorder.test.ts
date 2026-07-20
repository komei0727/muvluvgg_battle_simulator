import { describe, expect, it } from "vitest";
import { EventRecorder } from "./event-recorder.js";
import { createBattleId } from "../../shared/ids.js";
import { ExecutionGuardExceededError } from "../../shared/errors.js";

const BATTLE_ID = createBattleId("battle-1");

function recorder(): EventRecorder {
  return new EventRecorder(BATTLE_ID);
}

describe("EventRecorder", () => {
  it("UT-EVENT-RECORDER-001: assigns a monotonically increasing sequence and a battleId-scoped eventId", () => {
    const r = recorder();
    const scope = r.nextResolutionScopeId();

    const first = r.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });
    const second = r.record({
      eventType: "TurnCompleting",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      parentEventId: first.eventId,
      rootEventId: first.eventId,
      payload: { turnNumber: 1 },
    });

    expect(first.sequence).toBe(1);
    expect(first.eventId).toBe("battle-1:1");
    expect(second.sequence).toBe(2);
    expect(second.eventId).toBe("battle-1:2");
  });

  it("UT-EVENT-RECORDER-002: defaults rootEventId to the event's own eventId when omitted (top-level event)", () => {
    const r = recorder();

    const event = r.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: r.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    });

    expect(event.rootEventId).toBe(event.eventId);
    expect(event.parentEventId).toBeUndefined();
  });

  it("UT-EVENT-RECORDER-003: preserves an explicit rootEventId/parentEventId for a child event", () => {
    const r = recorder();
    const scope = r.nextResolutionScopeId();
    const root = r.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });

    const child = r.record({
      eventType: "ResourcesRecovered",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      parentEventId: root.eventId,
      rootEventId: root.eventId,
      payload: { units: [] },
    });

    expect(child.parentEventId).toBe(root.eventId);
    expect(child.rootEventId).toBe(root.eventId);
  });

  it("UT-EVENT-RECORDER-004: bumps stateVersion only for events that carry a stateDelta; TIMING events without a delta keep before === after", () => {
    const r = recorder();
    const scope = r.nextResolutionScopeId();

    const withoutDelta = r.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });
    expect(withoutDelta.stateVersionBefore).toBe(0);
    expect(withoutDelta.stateVersionAfter).toBe(0);

    const withDelta = r.record({
      eventType: "ResourcesRecovered",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { units: [] },
      stateDelta: { turnNumber: { before: 0, after: 1 } },
    });
    expect(withDelta.stateVersionBefore).toBe(0);
    expect(withDelta.stateVersionAfter).toBe(1);

    const next = r.record({
      eventType: "TurnCompleting",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });
    expect(next.stateVersionBefore).toBe(1);
    expect(next.stateVersionAfter).toBe(1);
  });

  it("UT-EVENT-RECORDER-005: nextActionId/nextSkillUseId/nextResolutionScopeId are battleId-scoped and monotonic", () => {
    const r = recorder();

    expect(r.nextActionId()).toBe("battle-1:action:1");
    expect(r.nextActionId()).toBe("battle-1:action:2");
    expect(r.nextSkillUseId()).toBe("battle-1:skill-use:1");
    expect(r.nextResolutionScopeId()).toBe("battle-1:scope:1");
  });

  it("UT-EVENT-RECORDER-007: nextEffectInstanceId is battleId-scoped and monotonic (Issue #23)", () => {
    const r = recorder();

    expect(r.nextEffectInstanceId()).toBe("battle-1:effect:1");
    expect(r.nextEffectInstanceId()).toBe("battle-1:effect:2");
  });

  it("UT-EVENT-RECORDER-006: getEvents returns all recorded events in recorded order", () => {
    const r = recorder();
    const scope = r.nextResolutionScopeId();
    r.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });
    r.record({
      eventType: "TurnCompleting",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: scope,
      payload: { turnNumber: 1 },
    });

    expect(r.getEvents().map((e) => e.eventType)).toEqual(["TurnStarted", "TurnCompleting"]);
  });

  it("review fix [P2]: throws a deterministic ExecutionGuardExceededError once the total-event SimulationExecutionGuard limit is reached, instead of accumulating events without bound", () => {
    const r = new EventRecorder(BATTLE_ID, 2);
    const scope = r.nextResolutionScopeId();
    const record = () =>
      r.record({
        eventType: "TurnStarted",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 0,
        resolutionScopeId: scope,
        payload: { turnNumber: 1 },
      });

    record();
    record();
    expect(() => record()).toThrow(ExecutionGuardExceededError);
    expect(r.getEvents()).toHaveLength(2);
  });
});
