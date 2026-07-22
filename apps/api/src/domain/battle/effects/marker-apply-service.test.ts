import { describe, expect, it } from "vitest";
import { applyMarker } from "./marker-apply-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import { createMarkerId, createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return createBattleUnit(member, "ALLY", LIMITS);
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: DomainEventId } {
  const recorder = new EventRecorder(createBattleId("B_1"));
  const seed = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    payload: { turnNumber: 1 },
  });
  return { recorder, rootEventId: seed.eventId };
}

const markerId = createMarkerId("MARKER_TEST");

const BATTLE_DURATION: DurationDefinition = {
  dispellable: true,
  linkedEffectGroupId: null,
};

function baseContext(recorder: EventRecorder, rootEventId: DomainEventId) {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
  };
}

describe("applyMarker", () => {
  it("UT-R-EFF-10-001: ADD creates a new MarkerState with stack 1 when none exists", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);

    const result = applyMarker(
      context,
      [source, target],
      {
        markerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: BATTLE_DURATION,
      },
      rootEventId,
    );

    expect(result.markerState.stackCount).toBe(1);
    expect(result.markerState.markerId).toBe(markerId);
    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(1);
    const events = recorder.getEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.eventType).toBe("MarkerApplied");
  });

  it("UT-R-EFF-10-002: ADD increments the stack of an existing MarkerState", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const request = {
      markerId,
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      stackPolicy: "ADD" as const,
      stackMax: null,
      durationDefinition: BATTLE_DURATION,
    };

    const first = applyMarker(context, [source, target], request, rootEventId);
    const second = applyMarker(context, first.units, request, first.lastEventId);

    expect(second.markerState.stackCount).toBe(2);
    const nextTarget = second.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(1);
    const events = recorder.getEvents();
    expect(events[events.length - 1]!.eventType).toBe("MarkerUpdated");
  });

  it("UT-R-EFF-10-003: ADD clamps at stack.max", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const request = {
      markerId,
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      stackPolicy: "ADD" as const,
      stackMax: 3,
      durationDefinition: BATTLE_DURATION,
    };

    let current: readonly BattleUnit[] = [source, target];
    let lastEventId = rootEventId;
    for (let i = 0; i < 5; i += 1) {
      const result = applyMarker(context, current, request, lastEventId);
      current = result.units;
      lastEventId = result.lastEventId;
    }

    const nextTarget = current.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates[0]!.stackCount).toBe(3);
  });

  it("UT-R-EFF-10-004: KEEP_EXISTING does not change an existing MarkerState and emits no event", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);

    const first = applyMarker(
      context,
      [source, target],
      {
        markerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: BATTLE_DURATION,
      },
      rootEventId,
    );
    const eventsAfterFirst = recorder.getEvents().length;

    const second = applyMarker(
      context,
      first.units,
      {
        markerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "KEEP_EXISTING",
        stackMax: null,
        durationDefinition: BATTLE_DURATION,
      },
      first.lastEventId,
    );

    expect(second.markerState.stackCount).toBe(1);
    expect(recorder.getEvents()).toHaveLength(eventsAfterFirst);
    expect(second.lastEventId).toBe(first.lastEventId);
  });

  it("UT-R-EFF-10-005: KEEP_EXISTING creates a new MarkerState when none exists", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);

    const result = applyMarker(
      context,
      [source, target],
      {
        markerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "KEEP_EXISTING",
        stackMax: null,
        durationDefinition: BATTLE_DURATION,
      },
      rootEventId,
    );

    expect(result.markerState.stackCount).toBe(1);
    expect(recorder.getEvents()[recorder.getEvents().length - 1]!.eventType).toBe("MarkerApplied");
  });

  it("UT-R-EFF-10-006: REFRESH keeps the stack count and resets the duration", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const actionDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      timeLimit: { unit: "ACTION", count: 3 },
    };
    const addRequest = {
      markerId,
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      stackPolicy: "ADD" as const,
      stackMax: null,
      durationDefinition: actionDuration,
    };

    const first = applyMarker(context, [source, target], addRequest, rootEventId);
    const grown = applyMarker(context, first.units, addRequest, first.lastEventId);
    const refreshed = applyMarker(
      context,
      grown.units,
      { ...addRequest, stackPolicy: "REFRESH" },
      grown.lastEventId,
    );

    expect(refreshed.markerState.stackCount).toBe(2);
    expect(refreshed.markerState.duration.timeLimitRemaining).toBe(3);
    const events = recorder.getEvents();
    expect(events[events.length - 1]!.eventType).toBe("MarkerUpdated");
  });

  it("UT-R-EFF-10-007: REPLACE resets stack to 1 and applies the new duration definition", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const actionDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      timeLimit: { unit: "ACTION", count: 3 },
    };
    const addRequest = {
      markerId,
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      stackPolicy: "ADD" as const,
      stackMax: null,
      durationDefinition: actionDuration,
    };

    const first = applyMarker(context, [source, target], addRequest, rootEventId);
    const grown = applyMarker(context, first.units, addRequest, first.lastEventId);

    const replacedDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      timeLimit: { unit: "TURN", count: 1 },
    };
    const replaced = applyMarker(
      context,
      grown.units,
      {
        markerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "REPLACE",
        stackMax: 5,
        durationDefinition: replacedDuration,
      },
      grown.lastEventId,
    );

    expect(replaced.markerState.stackCount).toBe(1);
    expect(replaced.markerState.stackMax).toBe(5);
    expect(replaced.markerState.duration.definition.timeLimit?.unit).toBe("TURN");
  });

  it("UT-R-EFF-10-008: ADD respects a stack.max of 1 (single-stack marker)", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const request = {
      markerId,
      sourceId: source.battleUnitId,
      targetId: target.battleUnitId,
      stackPolicy: "ADD" as const,
      stackMax: 1,
      durationDefinition: BATTLE_DURATION,
    };

    const first = applyMarker(context, [source, target], request, rootEventId);
    const second = applyMarker(context, first.units, request, first.lastEventId);

    expect(second.markerState.stackCount).toBe(1);
  });
});
