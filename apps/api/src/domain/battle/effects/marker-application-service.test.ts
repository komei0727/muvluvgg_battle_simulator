import { describe, expect, it } from "vitest";
import { applyMarkerToUnit, removeMarkerFromUnit } from "./marker-application-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createMarkerId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnit } from "../model/battle-unit.js";

const BATTLE_ID = createBattleId("battle-1");
const SOURCE = createBattleUnitId("enemy:1");
const TARGET = createBattleUnitId("ally:1");
const MARKER = createMarkerId("MARKER_WARNING_ROD");

function unit(): BattleUnit {
  return {
    battleUnitId: TARGET,
    unitDefinitionId: "UNIT_X" as never,
    attribute: "CUTE",
    side: "ALLY",
    position: { column: "LEFT", row: "FRONT" } as never,
    globalCoordinate: { x: 0, y: 2 },
    combatStats: {} as never,
    currentHp: 100,
    currentAp: 0,
    currentPp: 0,
    currentExtraGauge: 0,
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 100,
    cooldowns: {},
    appliedEffects: [],
    markers: [],
  };
}

function makeContext(recorder: EventRecorder) {
  const resolutionScopeId = recorder.nextResolutionScopeId();
  const root = recorder.record({
    eventType: "TurnStarted",
    category: "FACT",
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    payload: { turnNumber: 1 },
  });
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 1,
    resolutionScopeId,
    rootEventId: root.eventId,
    rootEvent: root,
  };
}

describe("applyMarkerToUnit (R-EFF-10)", () => {
  it("UT-EFF-MARKER-SVC-001: records MarkerApplied when the target has no existing Marker", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);

    const result = applyMarkerToUnit(
      ctx,
      [unit()],
      {
        markerId: MARKER,
        sourceId: SOURCE,
        targetId: TARGET,
        policy: "ADD",
        stackMax: null,
        duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      ctx.rootEvent.eventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.markers).toHaveLength(1);
    const applied = recorder.getEvents().find((e) => e.eventType === "MarkerApplied");
    expect(applied?.payload).toMatchObject({
      markerId: MARKER,
      targetUnitId: TARGET,
      stackCount: 1,
    });
    expect(recorder.getEvents().some((e) => e.eventType === "MarkerUpdated")).toBe(false);
  });

  it("UT-EFF-MARKER-SVC-002: records MarkerUpdated (not MarkerApplied again) when a Marker already exists", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const request = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      policy: "ADD" as const,
      stackMax: null,
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      dispellable: true,
      linkedEffectGroupId: null,
    };
    const first = applyMarkerToUnit(ctx, [unit()], request, ctx.rootEvent.eventId);

    const second = applyMarkerToUnit(ctx, first.units, request, first.lastEventId);

    const targetAfter = second.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.markers[0]?.stackCount).toBe(2);
    const updated = recorder.getEvents().find((e) => e.eventType === "MarkerUpdated");
    expect(updated?.payload).toMatchObject({
      markerId: MARKER,
      stackBefore: 1,
      stackAfter: 2,
      policy: "ADD",
    });
  });
});

describe("removeMarkerFromUnit", () => {
  it("UT-EFF-MARKER-SVC-003: removes the Marker and records MarkerRemoved with the given reason", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);
    const request = {
      markerId: MARKER,
      sourceId: SOURCE,
      targetId: TARGET,
      policy: "ADD" as const,
      stackMax: null,
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      dispellable: true,
      linkedEffectGroupId: null,
    };
    const granted = applyMarkerToUnit(ctx, [unit()], request, ctx.rootEvent.eventId);

    const result = removeMarkerFromUnit(
      ctx,
      granted.units,
      TARGET,
      MARKER,
      "EXPLICIT_REMOVE",
      granted.lastEventId,
    );

    const targetAfter = result.units.find((u) => u.battleUnitId === TARGET)!;
    expect(targetAfter.markers).toEqual([]);
    const removed = recorder.getEvents().find((e) => e.eventType === "MarkerRemoved");
    expect(removed?.payload).toMatchObject({
      markerId: MARKER,
      targetUnitId: TARGET,
      reason: "EXPLICIT_REMOVE",
    });
  });

  it("UT-EFF-MARKER-SVC-004: no-ops (no event) when the Marker doesn't exist", () => {
    const recorder = new EventRecorder(BATTLE_ID);
    const ctx = makeContext(recorder);

    const result = removeMarkerFromUnit(
      ctx,
      [unit()],
      TARGET,
      MARKER,
      "EXPLICIT_REMOVE",
      ctx.rootEvent.eventId,
    );

    expect(result.units.find((u) => u.battleUnitId === TARGET)?.markers).toEqual([]);
    expect(recorder.getEvents().some((e) => e.eventType === "MarkerRemoved")).toBe(false);
  });
});
