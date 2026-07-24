import { describe, expect, it } from "vitest";
import { applyMarker } from "./marker-apply-service.js";
import {
  emitMarkerDurationChangedEvents,
  removeMarkers,
  type MarkerRemovalSeed,
} from "./marker-removal-service.js";
import { decrementActionMarkerDurations } from "../model/marker-duration.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createActionId, type DomainEventId } from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
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

function baseContext(recorder: EventRecorder, rootEventId: DomainEventId) {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
  };
}

const BATTLE_DURATION: DurationDefinition = {
  dispellable: true,
  linkedEffectGroupId: null,
};

describe("removeMarkers", () => {
  it("UT-R-EFF-10-009: an explicit REMOVED seed removes the MarkerState and emits MarkerRemoved", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const markerId = createMarkerId("MARKER_TEST");

    const granted = applyMarker(
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

    const seeds: readonly MarkerRemovalSeed[] = [
      {
        battleUnitId: target.battleUnitId,
        markerInstanceId: granted.markerState.markerInstanceId,
        reason: "REMOVED",
      },
    ];
    const result = removeMarkers(context, granted.units, seeds, granted.lastEventId);

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    const events = recorder.getEvents();
    expect(events[events.length - 1]!.eventType).toBe("MarkerRemoved");
    expect(events[events.length - 1]!.payload).toMatchObject({
      reason: "REMOVED",
      cascaded: false,
    });
  });

  it("UT-R-TGT-08-007: a CONSUMPTION seed (R-TGT-08 Stealth consumption, TGT-004/Issue #167) removes the MarkerState and emits MarkerRemoved", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const markerId = createMarkerId("MARKER_STEALTH");

    const granted = applyMarker(
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

    const seeds: readonly MarkerRemovalSeed[] = [
      {
        battleUnitId: target.battleUnitId,
        markerInstanceId: granted.markerState.markerInstanceId,
        reason: "CONSUMPTION",
      },
    ];
    const result = removeMarkers(context, granted.units, seeds, granted.lastEventId);

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    const events = recorder.getEvents();
    expect(events[events.length - 1]!.eventType).toBe("MarkerRemoved");
    expect(events[events.length - 1]!.payload).toMatchObject({
      reason: "CONSUMPTION",
      cascaded: false,
    });
  });

  it("UT-R-EFF-10-010: a linkedEffectGroupId PARENT MarkerState removal cascades to its CHILD MarkerState", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const parentMarkerId = createMarkerId("MARKER_PARENT");
    const childMarkerId = createMarkerId("MARKER_CHILD");
    const groupDuration = (role: "PARENT" | "CHILD"): DurationDefinition => ({
      dispellable: true,
      linkedEffectGroupId: "GROUP_1",
      linkedEffectGroupRole: role,
    });

    const grantedParent = applyMarker(
      context,
      [source, target],
      {
        markerId: parentMarkerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: groupDuration("PARENT"),
      },
      rootEventId,
    );
    const grantedChild = applyMarker(
      context,
      grantedParent.units,
      {
        markerId: childMarkerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: groupDuration("CHILD"),
      },
      grantedParent.lastEventId,
    );

    const seeds: readonly MarkerRemovalSeed[] = [
      {
        battleUnitId: target.battleUnitId,
        markerInstanceId: grantedParent.markerState.markerInstanceId,
        reason: "REMOVED",
      },
    ];
    const result = removeMarkers(context, grantedChild.units, seeds, grantedChild.lastEventId);

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    const events = recorder.getEvents();
    const removedEvents = events.filter((e) => e.eventType === "MarkerRemoved");
    expect(removedEvents).toHaveLength(2);
    expect(removedEvents[0]!.payload).toMatchObject({ markerId: childMarkerId, cascaded: true });
    expect(removedEvents[1]!.payload).toMatchObject({ markerId: parentMarkerId, cascaded: false });
  });

  it("UT-R-EFF-10-011: a linkedEffectGroupId CHILD-only MarkerState removal does not cascade to its PARENT", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const parentMarkerId = createMarkerId("MARKER_PARENT");
    const childMarkerId = createMarkerId("MARKER_CHILD");
    const groupDuration = (role: "PARENT" | "CHILD"): DurationDefinition => ({
      dispellable: true,
      linkedEffectGroupId: "GROUP_1",
      linkedEffectGroupRole: role,
    });

    const grantedParent = applyMarker(
      context,
      [source, target],
      {
        markerId: parentMarkerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: groupDuration("PARENT"),
      },
      rootEventId,
    );
    const grantedChild = applyMarker(
      context,
      grantedParent.units,
      {
        markerId: childMarkerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: groupDuration("CHILD"),
      },
      grantedParent.lastEventId,
    );

    const seeds: readonly MarkerRemovalSeed[] = [
      {
        battleUnitId: target.battleUnitId,
        markerInstanceId: grantedChild.markerState.markerInstanceId,
        reason: "REMOVED",
      },
    ];
    const result = removeMarkers(context, grantedChild.units, seeds, grantedChild.lastEventId);

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates.map((m) => m.markerId)).toEqual([parentMarkerId]);
  });
});

describe("action-boundary Marker duration decrement + removal", () => {
  it("UT-R-EFF-10-012: an ACTION-scoped MarkerState reaches 0 remaining and is removed with reason TIME_LIMIT", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const markerId = createMarkerId("MARKER_TEST");
    const actionDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
    };

    const granted = applyMarker(
      context,
      [source, target],
      {
        markerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: actionDuration,
      },
      rootEventId,
    );

    const nextActionId = createActionId("B_1:action:2");
    const decrement = decrementActionMarkerDurations(
      granted.units,
      target.battleUnitId,
      nextActionId,
    );
    expect(decrement.changes).toHaveLength(1);
    expect(decrement.changes[0]!.after).toBe(0);

    const afterEmit = emitMarkerDurationChangedEvents(
      context,
      decrement.units,
      decrement.changes,
      granted.lastEventId,
    );

    const seeds: readonly MarkerRemovalSeed[] = decrement.changes
      .filter((change) => change.after === 0)
      .map((change) => ({
        battleUnitId: change.battleUnitId,
        markerInstanceId: change.markerInstanceId,
        reason: "TIME_LIMIT",
      }));
    const result = removeMarkers(context, decrement.units, seeds, afterEmit);

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    const events = recorder.getEvents();
    expect(events.some((e) => e.eventType === "MarkerUpdated")).toBe(true);
    const removedEvent = events.find((e) => e.eventType === "MarkerRemoved")!;
    expect(removedEvent.payload).toMatchObject({ reason: "TIME_LIMIT" });
  });
});
