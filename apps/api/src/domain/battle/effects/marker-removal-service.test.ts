import { describe, expect, it } from "vitest";
import { applyMarker } from "./marker-apply-service.js";
import {
  emitMarkerDurationChangedEvents,
  reduceMarkerStack,
  removeMarkers,
  type MarkerRemovalSeed,
} from "./marker-removal-service.js";
import { decrementActionMarkerDurations } from "../model/marker-duration.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import {
  createActionId,
  createEffectInstanceId,
  type DomainEventId,
} from "../../shared/event-ids.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

/** Marker同士のカスケードしか起こさないケース向け（cross-typeの子`AppliedEffect`が存在しない）。 */
const NO_EFFECT_ACTIONS: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition> = new Map();

function statModDefinition(id: string): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0 },
      stacking: { mode: "STACKABLE", max: null },
      duration: {
        dispellable: false,
        linkedEffectGroupId: "GROUP_1",
        linkedEffectGroupRole: "CHILD",
      },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

/** 既定で`GROUP_1`の`CHILD`ロールを持つ`AppliedEffect`（cross-typeカスケードの被連動側）。 */
function linkedEffect(
  id: string,
  target: BattleUnit,
  definitionId: EffectActionDefinitionId,
  overrides: Partial<AppliedEffect> = {},
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceId: target.battleUnitId,
    targetId: target.battleUnitId,
    magnitude: 0.025,
    duration: {
      definition: {
        dispellable: false,
        linkedEffectGroupId: "GROUP_1",
        linkedEffectGroupRole: "CHILD",
      },
    },
    appliedTurnNumber: 1,
    ...overrides,
  };
}

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
    const result = removeMarkers(
      context,
      granted.units,
      seeds,
      NO_EFFECT_ACTIONS,
      granted.lastEventId,
    );

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    const events = recorder.getEvents();
    expect(events[events.length - 1]!.eventType).toBe("MarkerRemoved");
    expect(events[events.length - 1]!.payload).toMatchObject({
      reason: "REMOVED",
      cascaded: false,
    });
  });

  it("UT-R-EFF-10-009b (REMOVE_EFFECTS_COUNT_LIMIT, M7-001): reduceMarkerStack removes only `count` stacks and emits MarkerUpdated when a positive stack remains", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const markerId = createMarkerId("MARKER_MAKENKI");

    // Build up 5 stacks via ADD.
    let units: readonly BattleUnit[] = [source, target];
    let lastEventId: DomainEventId = rootEventId;
    for (let i = 0; i < 5; i += 1) {
      const granted = applyMarker(
        context,
        units,
        {
          markerId,
          sourceId: source.battleUnitId,
          targetId: target.battleUnitId,
          stackPolicy: "ADD",
          stackMax: null,
          durationDefinition: BATTLE_DURATION,
        },
        lastEventId,
      );
      units = granted.units;
      lastEventId = granted.lastEventId;
    }

    const before = recorder.getEvents().length;
    const result = reduceMarkerStack(
      context,
      units,
      target.battleUnitId,
      markerId,
      3,
      NO_EFFECT_ACTIONS,
      lastEventId,
    );

    expect(result.changed).toBe(true);
    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(1);
    expect(nextTarget.markerStates[0]!.stackCount).toBe(2);
    const emitted = recorder.getEvents().slice(before);
    expect(emitted.map((e) => e.eventType)).toEqual(["MarkerUpdated"]);
    expect(emitted[0]!.payload).toMatchObject({ stackBefore: 5, stackAfter: 2 });
  });

  it("UT-R-EFF-10-009c (REMOVE_EFFECTS_COUNT_LIMIT, M7-001): reduceMarkerStack removes the instance (MarkerRemoved) when count meets or exceeds the stacks", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const markerId = createMarkerId("MARKER_MAKENKI");

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

    const before = recorder.getEvents().length;
    const result = reduceMarkerStack(
      context,
      granted.units,
      target.battleUnitId,
      markerId,
      3,
      NO_EFFECT_ACTIONS,
      granted.lastEventId,
    );

    expect(result.changed).toBe(true);
    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    expect(
      recorder
        .getEvents()
        .slice(before)
        .map((e) => e.eventType),
    ).toEqual(["MarkerRemoved"]);
  });

  it("UT-R-EFF-10-009d: reduceMarkerStack is a no-op (changed=false) when the target does not hold the marker", () => {
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);

    const before = recorder.getEvents().length;
    const result = reduceMarkerStack(
      context,
      [target],
      target.battleUnitId,
      createMarkerId("MARKER_ABSENT"),
      2,
      NO_EFFECT_ACTIONS,
      rootEventId,
    );

    expect(result.changed).toBe(false);
    expect(result.units).toEqual([target]);
    expect(recorder.getEvents().slice(before)).toHaveLength(0);
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
    const result = removeMarkers(
      context,
      grantedChild.units,
      seeds,
      NO_EFFECT_ACTIONS,
      grantedChild.lastEventId,
    );

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
    const result = removeMarkers(
      context,
      grantedChild.units,
      seeds,
      NO_EFFECT_ACTIONS,
      grantedChild.lastEventId,
    );

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates.map((m) => m.markerId)).toEqual([parentMarkerId]);
  });

  it("UT-R-EFF-09-015 (R-EFF-09 cross-type, M7-013): removing a PARENT MarkerState cascades to the CHILD AppliedEffects sharing its linkedEffectGroupId, emitting EffectExpired before MarkerRemoved", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const parentMarkerId = createMarkerId("MARKER_PARENT");
    const definition = statModDefinition("ACT_CHILD_ATK_UP");
    const childEffects = [
      linkedEffect("child-1", target, definition.effectActionDefinitionId),
      linkedEffect("child-2", target, definition.effectActionDefinitionId),
    ];

    const granted = applyMarker(
      context,
      [source, { ...target, appliedEffects: childEffects }],
      {
        markerId: parentMarkerId,
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_1",
          linkedEffectGroupRole: "PARENT",
        },
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
    const before = recorder.getEvents().length;
    const result = removeMarkers(
      context,
      granted.units,
      seeds,
      new Map([[definition.effectActionDefinitionId, definition]]),
      granted.lastEventId,
    );

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.appliedEffects).toHaveLength(0);
    expect(nextTarget.markerStates).toHaveLength(0);

    const events = recorder
      .getEvents()
      .slice(before)
      .filter((e) => e.eventType === "EffectExpired" || e.eventType === "MarkerRemoved");
    expect(events.map((e) => e.eventType)).toEqual([
      "EffectExpired",
      "EffectExpired",
      "MarkerRemoved",
    ]);
    expect(events[0]!.payload).toMatchObject({
      effectInstanceId: childEffects[0]!.effectInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      linkedEffectGroupId: "GROUP_1",
      cascaded: true,
    });
    expect(events[1]!.payload).toMatchObject({
      effectInstanceId: childEffects[1]!.effectInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(events[2]!.payload).toMatchObject({ reason: "REMOVED", cascaded: false });
    // R-STA-04: the cascaded APPLY_STAT_MOD removals re-run the CombatStat recalculation.
    expect(
      recorder
        .getEvents()
        .slice(before)
        .filter((e) => e.eventType === "CombatStatChanged").length,
    ).toBeGreaterThan(0);
  });

  it("UT-R-EFF-09-016 (R-EFF-09 cross-type, M7-013): a CHILD MarkerState removed alone does not cascade to the PARENT AppliedEffect of the same group", () => {
    const source = unit("source-1");
    const target = unit("target-1");
    const { recorder, rootEventId } = seedRecorder();
    const context = baseContext(recorder, rootEventId);
    const definition = statModDefinition("ACT_PARENT_ATK_UP");
    const parentEffect = linkedEffect("parent", target, definition.effectActionDefinitionId, {
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_1",
          linkedEffectGroupRole: "PARENT",
        },
      },
    });

    const granted = applyMarker(
      context,
      [source, { ...target, appliedEffects: [parentEffect] }],
      {
        markerId: createMarkerId("MARKER_CHILD"),
        sourceId: source.battleUnitId,
        targetId: target.battleUnitId,
        stackPolicy: "ADD",
        stackMax: null,
        durationDefinition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_1",
          linkedEffectGroupRole: "CHILD",
        },
      },
      rootEventId,
    );

    const result = removeMarkers(
      context,
      granted.units,
      [
        {
          battleUnitId: target.battleUnitId,
          markerInstanceId: granted.markerState.markerInstanceId,
          reason: "REMOVED",
        },
      ],
      new Map([[definition.effectActionDefinitionId, definition]]),
      granted.lastEventId,
    );

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    expect(nextTarget.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      parentEffect.effectInstanceId,
    ]);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectExpired")).toBe(false);
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
    const result = removeMarkers(context, decrement.units, seeds, NO_EFFECT_ACTIONS, afterEmit);

    const nextTarget = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(nextTarget.markerStates).toHaveLength(0);
    const events = recorder.getEvents();
    expect(events.some((e) => e.eventType === "MarkerUpdated")).toBe(true);
    const removedEvent = events.find((e) => e.eventType === "MarkerRemoved")!;
    expect(removedEvent.payload).toMatchObject({ reason: "TIME_LIMIT" });
  });
});
