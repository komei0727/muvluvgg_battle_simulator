import { describe, expect, it } from "vitest";
import { removeFreezeEffect } from "./freeze-removal-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
  type EffectActionDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
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

const FREEZE_DEFINITION_ID = createEffectActionDefinitionId("ACT_FREEZE");

function statModDefinition(id: string): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_STAT_MOD",
    payload: {
      stat: "ATTACK",
      valueType: "RATIO",
      formula: { kind: "CONSTANT", value: 0.2 },
      stacking: { mode: "STACKABLE" },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function freezeEffect(
  id: string,
  targetId: ReturnType<typeof createBattleUnitId>,
  duration: DurationDefinition = { dispellable: true, linkedEffectGroupId: null },
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: FREEZE_DEFINITION_ID,
    kindKey: effectKindKeyFromDefinitionId(FREEZE_DEFINITION_ID),
    duplicate: true,
    sourceId: targetId,
    targetId,
    magnitude: 0,
    statusKind: "FREEZE",
    duration: { definition: duration },
    appliedTurnNumber: 1,
  };
}

function statModEffect(
  id: string,
  targetId: ReturnType<typeof createBattleUnitId>,
  definitionId: EffectActionDefinitionId,
  duration: DurationDefinition,
  magnitude = 0.2,
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceId: targetId,
    targetId,
    magnitude,
    duration: { definition: duration },
    appliedTurnNumber: 1,
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

describe("removeFreezeEffect (R-STS-03/R-EFF-09)", () => {
  it("UT-R-STS-03-009: removes a freeze with no linked group, recording a single FreezeRemoved carrying triggeringDamage", () => {
    const freeze = freezeEffect("freeze-1", createBattleUnitId("target-1"));
    const target = unit("target-1", [freeze]);
    const { recorder, rootEventId } = createRoot();

    const result = removeFreezeEffect(
      context(recorder, rootEventId),
      [target],
      target.battleUnitId,
      freeze.effectInstanceId,
      30,
      new Map(),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);

    const freezeRemovedEvents = recorder
      .getEvents()
      .filter((ev) => ev.eventType === "FreezeRemoved");
    expect(freezeRemovedEvents).toHaveLength(1);
    expect(freezeRemovedEvents[0]!.payload).toEqual({
      effectInstanceId: freeze.effectInstanceId,
      battleUnitId: target.battleUnitId,
      triggeringDamage: 30,
    });
    expect(recorder.getEvents().some((ev) => ev.eventType === "EffectExpired")).toBe(false);
  });

  it("UT-R-STS-03-010 (R-EFF-09): cascades to a same-group sibling, emitting the child's EffectExpired (LINKED_GROUP_CASCADE) before the freeze's own FreezeRemoved", () => {
    const statMod = statModDefinition("ACT_LINK");
    const targetId = createBattleUnitId("target-1");
    const freeze = freezeEffect("freeze-1", targetId, {
      dispellable: true,
      linkedEffectGroupId: "GROUP_A",
    });
    const sibling = statModEffect("sibling-1", targetId, statMod.effectActionDefinitionId, {
      dispellable: true,
      linkedEffectGroupId: "GROUP_A",
    });
    // Simulate that the sibling stat mod was already contributing to
    // `combatStats` (as `grantEffect`/`recalculateCombatStats` would have
    // left it), so its cascade removal actually produces a detectable change.
    const baseTarget = unit("target-1", [freeze, sibling]);
    const target = { ...baseTarget, combatStats: { ...baseTarget.combatStats, attack: 120 } };
    const { recorder, rootEventId } = createRoot();

    const result = removeFreezeEffect(
      context(recorder, rootEventId),
      [target],
      target.battleUnitId,
      freeze.effectInstanceId,
      30,
      new Map([[statMod.effectActionDefinitionId, statMod]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(0);
    // The stat mod's +20% ATTACK bonus is gone once the sibling is cascaded away.
    expect(updated.combatStats.attack).toBe(BASE_COMBAT_STATS.attack);

    const relevantEvents = recorder
      .getEvents()
      .filter((ev) => ev.eventType === "EffectExpired" || ev.eventType === "FreezeRemoved");
    expect(relevantEvents.map((ev) => ev.eventType)).toEqual(["EffectExpired", "FreezeRemoved"]);
    expect(relevantEvents[0]!.payload).toMatchObject({
      effectInstanceId: sibling.effectInstanceId,
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(relevantEvents[1]!.payload).toEqual({
      effectInstanceId: freeze.effectInstanceId,
      battleUnitId: target.battleUnitId,
      triggeringDamage: 30,
    });

    const statChanged = recorder.getEvents().find((ev) => ev.eventType === "CombatStatChanged");
    expect(statChanged).toBeDefined();
    expect(statChanged!.payload).toMatchObject({ stat: "ATTACK", reason: "EFFECT_EXPIRED" });
  });

  it("UT-R-STS-03-011: a CHILD-role freeze expiring alone does not cascade to a PARENT-role sibling (R-EFF-09 child-consumption exception)", () => {
    const statMod = statModDefinition("ACT_LINK");
    const targetId = createBattleUnitId("target-1");
    const parentSibling = statModEffect("sibling-1", targetId, statMod.effectActionDefinitionId, {
      dispellable: true,
      linkedEffectGroupId: "GROUP_A",
      linkedEffectGroupRole: "PARENT",
    });
    const freeze = freezeEffect("freeze-1", targetId, {
      dispellable: true,
      linkedEffectGroupId: "GROUP_A",
      linkedEffectGroupRole: "CHILD",
    });
    const target = unit("target-1", [parentSibling, freeze]);
    const { recorder, rootEventId } = createRoot();

    const result = removeFreezeEffect(
      context(recorder, rootEventId),
      [target],
      target.battleUnitId,
      freeze.effectInstanceId,
      30,
      new Map([[statMod.effectActionDefinitionId, statMod]]),
      rootEventId,
    );

    const updated = result.units.find((u) => u.battleUnitId === target.battleUnitId)!;
    expect(updated.appliedEffects).toEqual([parentSibling]);
    expect(recorder.getEvents().some((ev) => ev.eventType === "EffectExpired")).toBe(false);
    expect(recorder.getEvents().filter((ev) => ev.eventType === "FreezeRemoved")).toHaveLength(1);
  });
});
