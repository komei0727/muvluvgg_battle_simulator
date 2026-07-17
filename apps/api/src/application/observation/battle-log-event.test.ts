import { describe, expect, it } from "vitest";
import { toBattleLogEvents } from "./battle-log-event.js";
import type { StateTransition } from "./battle-observation.js";
import type { BattleDomainEvent } from "../../domain/battle/events/domain-event.js";
import { createDomainEventId } from "../../domain/shared/event-ids.js";
import { EventRecorder } from "../../domain/battle/events/event-recorder.js";
import { DomainValidationError } from "../../domain/shared/errors.js";
import { createBattleId } from "../../domain/shared/ids.js";

const BATTLE_ID = createBattleId("battle-1");

/** `StateTransition[]`を実イベント列と同じ手順（stateDelta保持イベントの抽出）で組み立てる。 */
function stateTransitionsOf(events: ReturnType<EventRecorder["getEvents"]>): StateTransition[] {
  return events
    .filter((event) => event.stateDelta !== undefined)
    .map((event) => ({
      causedBySequence: event.sequence,
      stateVersionBefore: event.stateVersionBefore,
      stateVersionAfter: event.stateVersionAfter,
      stateDelta: event.stateDelta!,
    }));
}

describe("toBattleLogEvents", () => {
  it("UT-LOG-EVENT-001 (10_API設計.md BattleLogEventResponse): converts eventType to an UPPER_SNAKE_CASE type", () => {
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

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]!.type).toBe("BATTLE_STARTED");
  });

  it("UT-LOG-EVENT-002: carries category through unchanged", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "SkillUseStarting",
      category: "TIMING",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: {
        skillDefinitionId: "SKL_1" as never,
        actorUnitId: "ally:1" as never,
        targetUnitIds: [],
        costResource: "AP",
        costAmount: 1,
      },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]!.category).toBe("TIMING");
  });

  it("UT-LOG-EVENT-003: renames payload to details, passing the same content through unchanged", () => {
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

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]!.details).toEqual({
      turnLimit: 3,
      allySlotCount: 1,
      enemySlotCount: 1,
    });
    expect(logEvents[0]).not.toHaveProperty("payload");
  });

  it("UT-LOG-EVENT-004: resolves parentSequence and rootSequence from parentEventId/rootEventId, and omits eventId/parentEventId/rootEventId", () => {
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

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    // A root event (no parent) is its own root.
    expect(logEvents[0]!.parentSequence).toBeUndefined();
    expect(logEvents[0]!.rootSequence).toBe(logEvents[0]!.sequence);
    // A child inherits parentSequence and its parent's rootSequence.
    expect(logEvents[1]!.parentSequence).toBe(logEvents[0]!.sequence);
    expect(logEvents[1]!.rootSequence).toBe(logEvents[0]!.sequence);
    expect(logEvents[1]).not.toHaveProperty("parentEventId");
    expect(logEvents[1]).not.toHaveProperty("rootEventId");
    expect(logEvents[1]).not.toHaveProperty("eventId");
  });

  it("UT-LOG-EVENT-005: resolves parentSequence/rootSequence against the full event set even when the parent itself was filtered out of the visible subset", () => {
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

    const logEvents = toBattleLogEvents(visibleOnly, allEvents, stateTransitionsOf(allEvents));

    expect(logEvents).toHaveLength(1);
    expect(logEvents[0]!.parentSequence).toBe(turnStarted.sequence);
    expect(logEvents[0]!.rootSequence).toBe(turnStarted.sequence);
  });

  it("UT-LOG-EVENT-006: sets stateTransitionIndex to the 0-based position within stateTransitions, not the event's sequence", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    // A FACT event without a delta, so it does not occupy a stateTransitions slot.
    recorder.record({
      eventType: "TurnCompleting",
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
    const transitions = stateTransitionsOf(events);

    const logEvents = toBattleLogEvents(events, events, transitions);

    expect(logEvents[0]!.stateTransitionIndex).toBeUndefined();
    // BattleStarted is sequence 2, but the only (0-based) entry in stateTransitions.
    expect(logEvents[1]!.sequence).toBe(2);
    expect(logEvents[1]!.stateTransitionIndex).toBe(0);
    expect(transitions[logEvents[1]!.stateTransitionIndex!]!.causedBySequence).toBe(
      logEvents[1]!.sequence,
    );
  });

  it("UT-LOG-EVENT-007: does not duplicate stateDelta content on the event itself", () => {
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

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]).not.toHaveProperty("stateDelta");
  });

  it("UT-LOG-EVENT-008: passes actionId/skillUseId/sourceUnitId through when present", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const actionId = recorder.nextActionId();
    const skillUseId = recorder.nextSkillUseId();
    recorder.record({
      eventType: "TargetsSelected",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      actionId,
      skillUseId,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      sourceUnitId: "ally:1" as never,
      targetUnitIds: ["enemy:1" as never],
      payload: { skillDefinitionId: "SKL_1" as never, bindings: [] },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]!.actionId).toBe(actionId);
    expect(logEvents[0]!.skillUseId).toBe(skillUseId);
    expect(logEvents[0]!.sourceUnitId).toBe("ally:1");
  });

  it("UT-LOG-EVENT-009 (10_API設計.md「対象なしの場合は空配列」): targetUnitIds defaults to an empty array rather than being omitted", () => {
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

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]!.targetUnitIds).toEqual([]);
  });

  it("UT-LOG-EVENT-010: preserves the given targetUnitIds order when present", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    recorder.record({
      eventType: "TargetsSelected",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 1,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      targetUnitIds: ["enemy:2" as never, "enemy:1" as never],
      payload: { skillDefinitionId: "SKL_1" as never, bindings: [] },
    });
    const events = recorder.getEvents();

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]!.targetUnitIds).toEqual(["enemy:2", "enemy:1"]);
  });

  it("UT-LOG-EVENT-011: carries stateVersionBefore/stateVersionAfter through unchanged", () => {
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

    const logEvents = toBattleLogEvents(events, events, stateTransitionsOf(events));

    expect(logEvents[0]!.stateVersionBefore).toBe(0);
    expect(logEvents[0]!.stateVersionAfter).toBe(1);
  });

  it("UT-LOG-EVENT-012 (P2: 内部因果関係の破損を検出する): throws DomainValidationError when parentEventId references an eventId absent from the given event list, instead of silently omitting parentSequence", () => {
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
    const dangling: readonly BattleDomainEvent[] = [
      { ...events[0]!, parentEventId: createDomainEventId("battle-1:999") },
    ];

    expect(() => toBattleLogEvents(dangling, dangling, stateTransitionsOf(dangling))).toThrow(
      DomainValidationError,
    );
  });

  it("UT-LOG-EVENT-013: throws DomainValidationError when rootEventId references an eventId absent from the given event list", () => {
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
    const dangling: readonly BattleDomainEvent[] = [
      { ...events[0]!, rootEventId: createDomainEventId("battle-1:999") },
    ];

    expect(() => toBattleLogEvents(dangling, dangling, stateTransitionsOf(dangling))).toThrow(
      DomainValidationError,
    );
  });
});
