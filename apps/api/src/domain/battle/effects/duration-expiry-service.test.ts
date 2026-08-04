import { describe, expect, it } from "vitest";
import {
  emitEffectConsumptionChangedEvents,
  emitEffectDurationReducedEvents,
  expireEffects,
} from "./duration-expiry-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import { EventRecorder } from "../events/event-recorder.js";
import { toMarkerSnapshot } from "../events/state-delta.js";
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

function effect(
  id: string,
  targetUnitId: ReturnType<typeof createBattleUnitId>,
  definitionId: EffectActionDefinitionId,
  overrides: Partial<AppliedEffect> = {},
): AppliedEffect {
  const definition: DurationDefinition = { dispellable: true, linkedEffectGroupId: null };
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceUnitId: targetUnitId,
    targetUnitId,
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

describe("expireEffects", () => {
  it("UT-R-EFF-04-011 (no-op): returns the same units and parentEventId when there are no seeds", () => {
    const target = unit("target-1");
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [target],
      [],
      new Map(),
      rootEventId,
    );

    expect(result.units).toEqual([target]);
    expect(result.lastEventId).toBe(rootEventId);
    expect(recorder.getEvents().filter((ev) => ev.eventType === "EffectExpired")).toHaveLength(0);
  });

  it("UT-R-EFF-04-012 (R-EFF-04 #5/#6, R-STA-04): removes the expired instance, emits EffectExpired then CombatStatChanged, and reverts the stat", () => {
    const def = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    const e = effect("effect-1", target.battleUnitId, def.effectActionDefinitionId, {
      magnitude: 0.2,
    });
    // Simulate that this effect was already contributing to `combatStats`
    // (as `grantEffect`/`recalculateCombatStats` would have left it) so the
    // removal actually produces a `before !== after` change to detect.
    const withEffect = {
      ...target,
      appliedEffects: [e],
      combatStats: { ...target.combatStats, attack: 120 },
    };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withEffect],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: e.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);

    const events = recorder.getEvents();
    const expiredIndex = events.findIndex((ev) => ev.eventType === "EffectExpired");
    const statChangedIndex = events.findIndex((ev) => ev.eventType === "CombatStatChanged");
    expect(expiredIndex).toBeGreaterThanOrEqual(0);
    expect(statChangedIndex).toBeGreaterThan(expiredIndex);

    expect(events[expiredIndex]!.payload).toMatchObject({
      effectInstanceId: e.effectInstanceId,
      battleUnitId: target.battleUnitId,
      effectActionDefinitionId: def.effectActionDefinitionId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
    expect(events[statChangedIndex]!.payload).toMatchObject({
      stat: "ATTACK",
      reason: "EFFECT_EXPIRED",
    });
  });

  it("UT-R-EFF-09-005 (R-EFF-09): cascades to a same-group sibling, emitting the child's EffectExpired before the parent's", () => {
    const def = statModDefinition("ACT_LINK");
    const target = unit("target-1");
    const parent = effect("parent", target.battleUnitId, def.effectActionDefinitionId, {
      duration: { definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" } },
    });
    const child = effect("child", target.battleUnitId, def.effectActionDefinitionId, {
      duration: { definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" } },
    });
    const withEffects = { ...target, appliedEffects: [parent, child] };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withEffects],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: parent.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);

    const expiredEvents = recorder.getEvents().filter((ev) => ev.eventType === "EffectExpired");
    expect(expiredEvents).toHaveLength(2);
    expect(expiredEvents[0]!.payload).toMatchObject({
      effectInstanceId: child.effectInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(expiredEvents[1]!.payload).toMatchObject({
      effectInstanceId: parent.effectInstanceId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
  });

  it("UT-R-EFF-09-006 (R-EFF-09 / HARRIET_BARRIER): a PARENT-role member expiring via CONSUMPTION cascades to its CHILD-role sibling — role comes from linkedEffectGroupRole, not the expiration reason", () => {
    const def = statModDefinition("ACT_LINK");
    const target = unit("target-1");
    const immunity = effect("immunity", target.battleUnitId, def.effectActionDefinitionId, {
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "PARENT",
        },
      },
    });
    const continuousHeal = effect(
      "continuous-heal",
      target.battleUnitId,
      def.effectActionDefinitionId,
      {
        duration: {
          definition: {
            dispellable: true,
            linkedEffectGroupId: "GROUP_A",
            linkedEffectGroupRole: "CHILD",
          },
        },
      },
    );
    const withEffects = { ...target, appliedEffects: [immunity, continuousHeal] };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withEffects],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: immunity.effectInstanceId,
          reason: "CONSUMPTION",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);

    const expiredEvents = recorder.getEvents().filter((ev) => ev.eventType === "EffectExpired");
    expect(expiredEvents).toHaveLength(2);
    expect(expiredEvents[0]!.payload).toMatchObject({
      effectInstanceId: continuousHeal.effectInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(expiredEvents[1]!.payload).toMatchObject({
      effectInstanceId: immunity.effectInstanceId,
      reason: "CONSUMPTION",
      cascaded: false,
    });
  });

  it("UT-R-EFF-09-007 (R-EFF-09 子消費例外): a CHILD-role member expiring alone does NOT cascade to its PARENT sibling — the parent is preserved", () => {
    const def = statModDefinition("ACT_LINK");
    const target = unit("target-1");
    const immunity = effect("immunity", target.battleUnitId, def.effectActionDefinitionId, {
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "PARENT",
        },
      },
    });
    const continuousHeal = effect(
      "continuous-heal",
      target.battleUnitId,
      def.effectActionDefinitionId,
      {
        duration: {
          definition: {
            dispellable: true,
            linkedEffectGroupId: "GROUP_A",
            linkedEffectGroupRole: "CHILD",
          },
        },
      },
    );
    const withEffects = { ...target, appliedEffects: [immunity, continuousHeal] };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withEffects],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: continuousHeal.effectInstanceId,
          reason: "CONSUMPTION",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      immunity.effectInstanceId,
    ]);

    const expiredEvents = recorder.getEvents().filter((ev) => ev.eventType === "EffectExpired");
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0]!.payload).toMatchObject({
      effectInstanceId: continuousHeal.effectInstanceId,
      reason: "CONSUMPTION",
      cascaded: false,
    });
  });

  it("UT-R-EFF-09-014 (R-EFF-09 cross-type, M7-013): a PARENT AppliedEffect expiring cascades to the MarkerState sharing its linkedEffectGroupId, emitting MarkerRemoved before the parent's EffectExpired", () => {
    const def = statModDefinition("ACT_LINK");
    const target = unit("target-1");
    const parent = effect("parent", target.battleUnitId, def.effectActionDefinitionId, {
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "PARENT",
        },
      },
    });
    const childMarker: MarkerState = {
      markerInstanceId: createMarkerInstanceId("marker-child"),
      markerId: createMarkerId("MARKER_CHILD"),
      sourceUnitId: target.battleUnitId,
      targetUnitId: target.battleUnitId,
      stackCount: 2,
      stackMax: null,
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
    const withBoth = { ...target, appliedEffects: [parent], markerStates: [childMarker] };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withBoth],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: parent.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);
    expect(updated.markerStates).toHaveLength(0);

    const cascadeEvents = recorder
      .getEvents()
      .filter((ev) => ev.eventType === "MarkerRemoved" || ev.eventType === "EffectExpired");
    expect(cascadeEvents.map((ev) => ev.eventType)).toEqual(["MarkerRemoved", "EffectExpired"]);
    expect(cascadeEvents[0]!.payload).toMatchObject({
      markerInstanceId: childMarker.markerInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      linkedEffectGroupId: "GROUP_A",
      cascaded: true,
    });
    expect(cascadeEvents[0]!.stateDelta).toEqual({
      units: {
        [target.battleUnitId]: {
          markers: {
            [childMarker.markerInstanceId]: {
              before: toMarkerSnapshot(childMarker),
              after: undefined,
            },
          },
        },
      },
    });
    expect(cascadeEvents[1]!.payload).toMatchObject({
      effectInstanceId: parent.effectInstanceId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
  });

  it("UT-R-EFF-09-021 (R-EFF-09 順序): when a CHILD and its PARENT both become seeds in the same batch, the CHILD expires first regardless of the input order", () => {
    const def = statModDefinition("ACT_LINK");
    const target = unit("target-1");
    // 同じグループのPARENTとCHILDが同一ターンで同時に0になり、`units`/`changes`上は
    // PARENTが先に並ぶ（= seedsの入力順もPARENTが先）ケース。
    const parent = effect("parent", target.battleUnitId, def.effectActionDefinitionId, {
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "PARENT",
        },
      },
    });
    const child = effect("child", target.battleUnitId, def.effectActionDefinitionId, {
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: "GROUP_A",
          linkedEffectGroupRole: "CHILD",
        },
      },
    });
    const withEffects = { ...target, appliedEffects: [parent, child] };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withEffects],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: parent.effectInstanceId,
          reason: "TIME_LIMIT",
        },
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: child.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);

    const expiredEvents = recorder.getEvents().filter((ev) => ev.eventType === "EffectExpired");
    expect(expiredEvents).toHaveLength(2);
    // どちらも自身の時間制限で失効した`seeds`（cascade分ではない）ため、
    // `reason`は`TIME_LIMIT`／`cascaded: false`のまま。順序だけがロール順になる。
    expect(expiredEvents[0]!.payload).toMatchObject({
      effectInstanceId: child.effectInstanceId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
    expect(expiredEvents[1]!.payload).toMatchObject({
      effectInstanceId: parent.effectInstanceId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
  });

  it("UT-R-EFF-09-024 (R-EFF-09 順序): a non-seed PARENT pulled in by the cascade still expires after every CHILD, seed or not", () => {
    const def = statModDefinition("ACT_LINK");
    const target = unit("target-1");
    const group = (role: "PARENT" | "CHILD") => ({
      definition: {
        dispellable: true,
        linkedEffectGroupId: "GROUP_A",
        linkedEffectGroupRole: role,
      },
    });
    // 同一グループに複数PARENT（スキーマは禁じていない）。
    // `parentSeed`と`childSeed`が同時に0になり、`parentCascaded`はカスケードで
    // 巻き込まれるだけ（seedではない）。
    const parentCascaded = effect(
      "parent-cascaded",
      target.battleUnitId,
      def.effectActionDefinitionId,
      { duration: group("PARENT") },
    );
    const parentSeed = effect("parent-seed", target.battleUnitId, def.effectActionDefinitionId, {
      duration: group("PARENT"),
    });
    const childSeed = effect("child-seed", target.battleUnitId, def.effectActionDefinitionId, {
      duration: group("CHILD"),
    });
    const withEffects = {
      ...target,
      appliedEffects: [parentCascaded, parentSeed, childSeed],
    };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withEffects],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: parentSeed.effectInstanceId,
          reason: "TIME_LIMIT",
        },
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: childSeed.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    expect(
      result.units.find((u) => u.battleUnitId === target.battleUnitId)!.appliedEffects,
    ).toHaveLength(0);

    const expired = recorder
      .getEvents()
      .filter((ev) => ev.eventType === "EffectExpired")
      .map((ev) => ev.payload as { effectInstanceId: string; reason: string; cascaded: boolean });
    expect(expired).toHaveLength(3);
    // 除去バッチ全体（カスケード分＋seed分）が単一のrole順で並ぶ: CHILDが先頭。
    expect(expired[0]).toMatchObject({
      effectInstanceId: childSeed.effectInstanceId,
      reason: "TIME_LIMIT",
      cascaded: false,
    });
    // 残り2件はどちらもPARENT。メンバー固有のreason/cascadedは保持される。
    expect(
      expired
        .slice(1)
        .map((e) => e.effectInstanceId)
        .sort(),
    ).toEqual([parentCascaded.effectInstanceId, parentSeed.effectInstanceId].sort());
    expect(
      expired.find((e) => e.effectInstanceId === parentCascaded.effectInstanceId),
    ).toMatchObject({ reason: "LINKED_GROUP_CASCADE", cascaded: true });
    expect(expired.find((e) => e.effectInstanceId === parentSeed.effectInstanceId)).toMatchObject({
      reason: "TIME_LIMIT",
      cascaded: false,
    });
  });

  it("UT-R-EFF-06-005 (R-EFF-05/06 next-best promotion): promotes the next-strongest non-stackable effect and emits EffectiveEffectChanged", () => {
    const def = statModDefinition("ACT_ATK_UP_UNIQUE");
    const target = unit("target-1");
    const strongest = effect("strongest", target.battleUnitId, def.effectActionDefinitionId, {
      duplicate: false,
      magnitude: 0.3,
    });
    const nextBest = effect("next-best", target.battleUnitId, def.effectActionDefinitionId, {
      duplicate: false,
      magnitude: 0.1,
    });
    const withEffects = { ...target, appliedEffects: [strongest, nextBest] };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [withEffects],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: strongest.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      new Map([[def.effectActionDefinitionId, def]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects.map((eff) => eff.effectInstanceId)).toEqual([
      nextBest.effectInstanceId,
    ]);

    const effectiveChanged = recorder
      .getEvents()
      .filter((ev) => ev.eventType === "EffectiveEffectChanged");
    expect(effectiveChanged).toHaveLength(1);
    expect(effectiveChanged[0]!.payload).toMatchObject({
      before: strongest.effectInstanceId,
      after: nextBest.effectInstanceId,
    });
  });
});

describe("emitEffectDurationReducedEvents", () => {
  it("UT-R-EFF-04-013 (R-EFF-04 #3): emits EffectDurationReduced per change with a before/after stateDelta reflecting only the remaining count", () => {
    const def = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    const e = effect("effect-1", target.battleUnitId, def.effectActionDefinitionId, {
      duration: {
        definition: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        timeLimitRemaining: 1,
      },
    });
    const withEffect = { ...target, appliedEffects: [e] };
    const { recorder, rootEventId } = createRoot();

    const lastEventId = emitEffectDurationReducedEvents(
      context(recorder, rootEventId),
      [withEffect],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: e.effectInstanceId,
          unit: "ACTION",
          before: 2,
          after: 1,
        },
      ],
      rootEventId,
    );

    const events = recorder.getEvents().filter((ev) => ev.eventType === "EffectDurationReduced");
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe(lastEventId);
    expect(events[0]!.payload).toMatchObject({
      effectInstanceId: e.effectInstanceId,
      battleUnitId: target.battleUnitId,
      unit: "ACTION",
      before: 2,
      after: 1,
    });
    const delta =
      events[0]!.stateDelta?.units?.[target.battleUnitId]?.effects?.[e.effectInstanceId];
    expect(delta?.before).toMatchObject({ duration: { unit: "ACTION", remaining: 2 } });
    expect(delta?.after).toMatchObject({ duration: { unit: "ACTION", remaining: 1 } });
  });

  it("UT-R-EFF-04-014: returns parentEventId unchanged when there are no changes", () => {
    const target = unit("target-1");
    const { recorder, rootEventId } = createRoot();

    const lastEventId = emitEffectDurationReducedEvents(
      context(recorder, rootEventId),
      [target],
      [],
      rootEventId,
    );

    expect(lastEventId).toBe(rootEventId);
    expect(
      recorder.getEvents().filter((ev) => ev.eventType === "EffectDurationReduced"),
    ).toHaveLength(0);
  });
});

describe("emitEffectConsumptionChangedEvents", () => {
  it("UT-R-EFF-07-005 (R-EFF-07): emits EffectConsumptionChanged per change with a before/after stateDelta reflecting only consumptionRemaining", () => {
    const def = statModDefinition("ACT_ATK_UP");
    const target = unit("target-1");
    const e = effect("effect-1", target.battleUnitId, def.effectActionDefinitionId, {
      duration: {
        definition: {
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
        consumptionRemaining: 0,
      },
    });
    const withEffect = { ...target, appliedEffects: [e] };
    const { recorder, rootEventId } = createRoot();

    const lastEventId = emitEffectConsumptionChangedEvents(
      context(recorder, rootEventId),
      [withEffect],
      [
        {
          battleUnitId: target.battleUnitId,
          effectInstanceId: e.effectInstanceId,
          kind: "NEXT_OUTGOING_ATTACK",
          before: 1,
          after: 0,
        },
      ],
      rootEventId,
    );

    const events = recorder.getEvents().filter((ev) => ev.eventType === "EffectConsumptionChanged");
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe(lastEventId);
    expect(events[0]!.payload).toMatchObject({
      effectInstanceId: e.effectInstanceId,
      battleUnitId: target.battleUnitId,
      kind: "NEXT_OUTGOING_ATTACK",
      before: 1,
      after: 0,
    });
    const delta =
      events[0]!.stateDelta?.units?.[target.battleUnitId]?.effects?.[e.effectInstanceId];
    expect(delta?.before).toMatchObject({ consumptionRemaining: 1 });
    expect(delta?.after).toMatchObject({ consumptionRemaining: 0 });
  });

  it("UT-R-EFF-07-006: returns parentEventId unchanged when there are no changes", () => {
    const target = unit("target-1");
    const { recorder, rootEventId } = createRoot();

    const lastEventId = emitEffectConsumptionChangedEvents(
      context(recorder, rootEventId),
      [target],
      [],
      rootEventId,
    );

    expect(lastEventId).toBe(rootEventId);
    expect(
      recorder.getEvents().filter((ev) => ev.eventType === "EffectConsumptionChanged"),
    ).toHaveLength(0);
  });
});

/**
 * M7-012（Issue #266、R-EFF-05）: 「採用中の最強効果が失効・解除された場合、
 * 残っている同種効果を再評価し、次に強い1件を即時に有効化する」（次点繰上げ）を、
 * 実際の失効経路（`action-completion.ts`/`battle.ts`が呼ぶ`expireEffects`）で
 * 検証する。`effective-effect-selector.ts`の純粋関数レベルの検証は
 * `UT-R-EFF-05-006`が担う。
 */
describe("expireEffects: R-EFF-05 次点繰上げ (M7-012, Issue #266)", () => {
  const NON_STACKABLE_DEFINITION_ID = createEffectActionDefinitionId("ACT_NON_STACKABLE_ATK_UP");

  function nonStackableStatModDefinition(): EffectActionDefinition {
    return {
      effectActionDefinitionId: NON_STACKABLE_DEFINITION_ID,
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0 },
        stacking: { mode: "NON_STACKABLE", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
      requiredCapabilities: [],
      metadata: { tags: [] },
    };
  }

  it("UT-R-EFF-05-021 (real lifecycle wiring): expiring the current winner promotes the surviving runner-up, emitting EffectiveEffectChanged before CombatStatChanged", () => {
    const targetUnitId = createBattleUnitId("target-1");
    const strongest = effect("E_STRONG", targetUnitId, NON_STACKABLE_DEFINITION_ID, {
      duplicate: false,
      magnitude: 0.5,
    });
    const runnerUp = effect("E_RUNNER_UP", targetUnitId, NON_STACKABLE_DEFINITION_ID, {
      duplicate: false,
      magnitude: 0.2,
    });
    const target = {
      ...unit("target-1", [strongest, runnerUp]),
      // 最強1件（+50%）だけが採用されている状態から始める（R-EFF-05第3項）。
      combatStats: { ...BASE_COMBAT_STATS, attack: BASE_COMBAT_STATS.attack * 1.5 },
    };
    const { recorder, rootEventId } = createRoot();

    const result = expireEffects(
      context(recorder, rootEventId),
      [target],
      [
        {
          battleUnitId: targetUnitId,
          effectInstanceId: strongest.effectInstanceId,
          reason: "TIME_LIMIT",
        },
      ],
      new Map([[NON_STACKABLE_DEFINITION_ID, nonStackableStatModDefinition()]]),
      rootEventId,
    );

    const after = result.units.find((u) => u.battleUnitId === targetUnitId)!;
    expect(after.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      runnerUp.effectInstanceId,
    ]);
    // 次点（+20%）が即時に有効化される。
    expect(after.combatStats.attack).toBe(BASE_COMBAT_STATS.attack * 1.2);

    const emitted = recorder.getEvents().map((e) => e.eventType);
    expect(emitted).toContain("EffectiveEffectChanged");
    expect(emitted.indexOf("EffectExpired")).toBeLessThan(
      emitted.indexOf("EffectiveEffectChanged"),
    );
    expect(emitted.indexOf("EffectiveEffectChanged")).toBeLessThan(
      emitted.indexOf("CombatStatChanged"),
    );

    const changed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectiveEffectChanged") as Extract<
      ReturnType<EventRecorder["getEvents"]>[number],
      { eventType: "EffectiveEffectChanged" }
    >;
    expect(changed.payload).toEqual({
      battleUnitId: targetUnitId,
      kindKey: NON_STACKABLE_DEFINITION_ID,
      before: strongest.effectInstanceId,
      after: runnerUp.effectInstanceId,
    });
  });
});
