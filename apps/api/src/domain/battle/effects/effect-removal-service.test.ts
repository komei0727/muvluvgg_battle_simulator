import { describe, expect, it } from "vitest";

import { removeEffects } from "./effect-removal-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import { EventRecorder } from "../events/event-recorder.js";
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
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";

const BASE_COMBAT_STATS: CombatStats = {
  maximumHp: 1000,
  attack: 100,
  defense: 50,
  criticalRate: 0.1,
  actionSpeed: 10,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
};

function unit(id: string, appliedEffects: readonly AppliedEffect[] = []): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate("ALLY", position),
    combatStats: BASE_COMBAT_STATS,
  };
  const base = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...base, appliedEffects };
}

function statModDefinition(id: string): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0 },
      stacking: { mode: "STACKABLE", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function statusDefinition(id: string): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STATUS",
    payload: { status: "STUN", duration: { dispellable: true, linkedEffectGroupId: null } },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function effect(
  id: string,
  targetId: ReturnType<typeof createBattleUnitId>,
  definitionId: EffectActionDefinitionId,
  overrides: Partial<AppliedEffect> = {},
): AppliedEffect {
  const definition: DurationDefinition = { dispellable: true, linkedEffectGroupId: null };
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceId: targetId,
    targetId,
    magnitude: 0.2,
    categories: ["BUFF"],
    duration: { definition },
    appliedTurnNumber: 1,
    ...overrides,
  };
}

function createRoot(): {
  recorder: EventRecorder;
  rootEventId: ReturnType<EventRecorder["record"]>["eventId"];
} {
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

const context = (
  recorder: EventRecorder,
  rootEventId: ReturnType<EventRecorder["record"]>["eventId"],
) => ({
  recorder,
  turnNumber: 1,
  cycleNumber: 0,
  resolutionScopeId: recorder.nextResolutionScopeId(),
  rootEventId,
});

describe("removeEffects (R-EFF-02)", () => {
  it("UT-R-EFF-02-010 (no-op): returns the same units and parentEventId when nothing matches", () => {
    const buffDef = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    const buff = effect("effect-1", target.battleUnitId, buffDef.effectActionDefinitionId, {
      magnitude: 0.2,
    });
    const withEffect = { ...target, appliedEffects: [buff] };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withEffect],
      target.battleUnitId,
      { categories: ["DEBUFF"] },
      new Map([[buffDef.effectActionDefinitionId, buffDef]]),
      rootEventId,
    );

    expect(result.removedCount).toBe(0);
    expect(result.units).toEqual([withEffect]);
    expect(result.lastEventId).toBe(rootEventId);
    expect(recorder.getEvents().filter((ev) => ev.eventType === "EffectRemoved")).toHaveLength(0);
  });

  it("UT-R-EFF-02-011 (REMOVE_BUFF_CATEGORY): removes every BUFF, emits EffectRemoved (reason REMOVED) + CombatStatChanged, and reverts the stat", () => {
    const buffDef = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    const buff = effect("effect-1", target.battleUnitId, buffDef.effectActionDefinitionId, {
      magnitude: 0.2,
    });
    const withEffect = {
      ...target,
      appliedEffects: [buff],
      combatStats: { ...target.combatStats, attack: 120 },
    };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withEffect],
      target.battleUnitId,
      { categories: ["BUFF"] },
      new Map([[buffDef.effectActionDefinitionId, buffDef]]),
      rootEventId,
    );

    expect(result.removedCount).toBe(1);
    expect(result.units[0]!.appliedEffects).toHaveLength(0);
    expect(result.units[0]!.combatStats.attack).toBe(100);
    const removedEvents = recorder.getEvents().filter((ev) => ev.eventType === "EffectRemoved");
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0]!.payload).toMatchObject({ reason: "REMOVED", cascaded: false });
    const statChanges = recorder.getEvents().filter((ev) => ev.eventType === "CombatStatChanged");
    expect(statChanges[0]!.payload).toMatchObject({ reason: "EFFECT_REMOVED" });
  });

  it("UT-R-EFF-02-012 (REMOVE_EFFECTS_COUNT_LIMIT): removes only maxRemovals debuffs in grant order (oldest first)", () => {
    const debuffDef = statModDefinition("ACT_ATK_DOWN");
    const target = unit("target-1");
    const debuffs = [1, 2, 3, 4].map((n) =>
      effect(`effect-${n}`, target.battleUnitId, debuffDef.effectActionDefinitionId, {
        magnitude: -0.1,
      }),
    );
    const withEffects = { ...target, appliedEffects: debuffs };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withEffects],
      target.battleUnitId,
      { categories: ["DEBUFF"], maxRemovals: 2 },
      new Map([[debuffDef.effectActionDefinitionId, debuffDef]]),
      rootEventId,
    );

    expect(result.removedCount).toBe(2);
    const remaining = result.units[0]!.appliedEffects.map((e) => e.effectInstanceId);
    expect(remaining).toEqual([
      createEffectInstanceId("effect-3"),
      createEffectInstanceId("effect-4"),
    ]);
  });

  it("UT-R-EFF-02-013 (R-STS-01): DEBUFF removal also clears 状態異常 statuses (STUN)", () => {
    const statusDef = statusDefinition("ACT_STUN");
    const target = unit("target-1");
    const stun = effect("effect-1", target.battleUnitId, statusDef.effectActionDefinitionId, {
      magnitude: 0,
      statusKind: "STUN",
    });
    const withEffect = { ...target, appliedEffects: [stun] };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withEffect],
      target.battleUnitId,
      { categories: ["DEBUFF"] },
      new Map([[statusDef.effectActionDefinitionId, statusDef]]),
      rootEventId,
    );

    expect(result.removedCount).toBe(1);
    expect(result.units[0]!.appliedEffects).toHaveLength(0);
  });

  it("UT-R-EFF-02-014 (BUFF removal leaves 状態異常 debuffs untouched)", () => {
    const statusDef = statusDefinition("ACT_STUN");
    const target = unit("target-1");
    const stun = effect("effect-1", target.battleUnitId, statusDef.effectActionDefinitionId, {
      magnitude: 0,
      statusKind: "STUN",
    });
    const withEffect = { ...target, appliedEffects: [stun] };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withEffect],
      target.battleUnitId,
      { categories: ["BUFF"] },
      new Map([[statusDef.effectActionDefinitionId, statusDef]]),
      rootEventId,
    );

    expect(result.removedCount).toBe(0);
    expect(result.units[0]!.appliedEffects).toHaveLength(1);
  });

  it("UT-R-EFF-02-015 (R-EFF-01, review [P1]): a dispellable:false BUFF is not directly removed", () => {
    const buffDef = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    const permanent = effect("effect-1", target.battleUnitId, buffDef.effectActionDefinitionId, {
      magnitude: 0.2,
      duration: { definition: { dispellable: false, linkedEffectGroupId: null } },
    });
    const withEffect = { ...target, appliedEffects: [permanent] };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withEffect],
      target.battleUnitId,
      { categories: ["BUFF"] },
      new Map([[buffDef.effectActionDefinitionId, buffDef]]),
      rootEventId,
    );

    expect(result.removedCount).toBe(0);
    expect(result.units[0]!.appliedEffects).toHaveLength(1);
    expect(recorder.getEvents().filter((ev) => ev.eventType === "EffectRemoved")).toHaveLength(0);
  });

  it("UT-R-EFF-02-016 (R-EFF-09, review [P2]): when a linked parent and child both match, the child is removed first (LINKED_GROUP_CASCADE) and the parent last (REMOVED)", () => {
    const buffDef = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    // Granted parent-first (appliedEffects order [parent, child]); both are BUFFs
    // and both match, but R-EFF-09 requires child-first cascade order.
    const parent = effect("parent", target.battleUnitId, buffDef.effectActionDefinitionId, {
      magnitude: 0.2,
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "G1",
          linkedEffectGroupRole: "PARENT",
        },
      },
    });
    const child = effect("child", target.battleUnitId, buffDef.effectActionDefinitionId, {
      magnitude: 0.3,
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "G1",
          linkedEffectGroupRole: "CHILD",
        },
      },
    });
    const withEffects = { ...target, appliedEffects: [parent, child] };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withEffects],
      target.battleUnitId,
      { categories: ["BUFF"] },
      new Map([[buffDef.effectActionDefinitionId, buffDef]]),
      rootEventId,
    );

    expect(result.units[0]!.appliedEffects).toHaveLength(0);
    const removed = recorder
      .getEvents()
      .filter((ev) => ev.eventType === "EffectRemoved")
      .map((ev) => ev.payload as { effectInstanceId: string; reason: string; cascaded: boolean });
    expect(removed).toHaveLength(2);
    expect(removed[0]).toMatchObject({
      effectInstanceId: createEffectInstanceId("child"),
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(removed[1]).toMatchObject({
      effectInstanceId: createEffectInstanceId("parent"),
      reason: "REMOVED",
      cascaded: false,
    });
  });
  it("UT-R-EFF-09-017 (R-EFF-09 cross-type, M7-013): removing a PARENT AppliedEffect cascades to the MarkerState sharing its linkedEffectGroupId (MarkerRemoved / LINKED_GROUP_CASCADE)", () => {
    const buffDef = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    const parent = effect("parent", target.battleUnitId, buffDef.effectActionDefinitionId, {
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "G1",
          linkedEffectGroupRole: "PARENT",
        },
      },
    });
    const childMarker: MarkerState = {
      markerInstanceId: createMarkerInstanceId("marker-child"),
      markerId: createMarkerId("MARKER_CHILD"),
      sourceId: target.battleUnitId,
      targetId: target.battleUnitId,
      stackCount: 1,
      stackMax: null,
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "G1",
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
    const withBoth = { ...target, appliedEffects: [parent], markerStates: [childMarker] };
    const { recorder, rootEventId } = createRoot();

    const result = removeEffects(
      context(recorder, rootEventId),
      [withBoth],
      target.battleUnitId,
      { categories: ["BUFF"] },
      new Map([[buffDef.effectActionDefinitionId, buffDef]]),
      rootEventId,
    );

    expect(result.units[0]!.appliedEffects).toHaveLength(0);
    expect(result.units[0]!.markerStates).toHaveLength(0);
    // R-EFF-02 #3「解除数」はcascade分を含めない — Markerも同様。
    expect(result.removedCount).toBe(1);
    const cascadeEvents = recorder
      .getEvents()
      .filter((ev) => ev.eventType === "MarkerRemoved" || ev.eventType === "EffectRemoved");
    expect(cascadeEvents.map((ev) => ev.eventType)).toEqual(["MarkerRemoved", "EffectRemoved"]);
    expect(cascadeEvents[0]!.payload).toMatchObject({
      markerInstanceId: childMarker.markerInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      linkedEffectGroupId: "G1",
      cascaded: true,
    });
    expect(cascadeEvents[1]!.payload).toMatchObject({
      effectInstanceId: parent.effectInstanceId,
      reason: "REMOVED",
      cascaded: false,
    });
  });
});
