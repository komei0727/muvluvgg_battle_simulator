import { describe, expect, it } from "vitest";
import { applyHealAction } from "./heal-application-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { ResolvedEffectApplication } from "../skill/skill-resolution-service.js";

function unit(
  id: string,
  side: Side,
  overrides: { currentHp?: number; maximumHp?: number; attack?: number } = {},
): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: overrides.maximumHp ?? 100,
      attack: overrides.attack ?? 100,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  const built = createBattleUnit(member, side, {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 10,
  });
  return { ...built, currentHp: overrides.currentHp ?? built.currentHp };
}

function healAction(
  id: string,
  payload: Extract<EffectActionDefinition, { kind: "HEAL" }>["payload"],
): Extract<EffectActionDefinition, { kind: "HEAL" }> {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "HEAL",
    payload,
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function hit(targetId: string, actionId: string, hitIndex = 0): ResolvedEffectApplication {
  return {
    targetBattleUnitId: createBattleUnitId(targetId),
    effectActionDefinitionId: createEffectActionDefinitionId(actionId),
    hitIndex,
  };
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: DomainEventIdOf } {
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

type DomainEventIdOf = ReturnType<EventRecorder["record"]>["eventId"];

function context(
  recorder: EventRecorder,
  rootEventId: DomainEventIdOf,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition> = new Map(),
): Parameters<typeof applyHealAction>[4] {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId,
    parentEventId: rootEventId,
    sourceUnitId: createBattleUnitId("HEALER"),
    effectActions,
  };
}

describe("applyHealAction (R-HEAL-01, M7-005 Issue #184)", () => {
  it("UT-R-HEAL-01-001: HEAL(MAX_HP_RATIO 0.3) raises target HP by 30% of max and emits HealApplied carrying the hp StateDelta", () => {
    const healer = unit("HEALER", "ALLY", { currentHp: 100, maximumHp: 100 });
    const target = unit("TARGET", "ALLY", { currentHp: 40, maximumHp: 100 });
    const action = healAction("ACT_HEAL", {
      formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
      overheal: "DISCARD",
      distribution: "NONE",
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      action,
      [healer, target],
      context(recorder, rootEventId),
    );

    const healed = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(healed.currentHp).toBe(70);
    expect(result.changed).toBe(true);
    expect(result.resolvedCount).toBe(1);

    const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      targetUnitId: createBattleUnitId("TARGET"),
      formulaResult: 30,
      distributionShareCount: 1,
      healingModifierMultiplier: 1,
      healAmount: 30,
      appliedAmount: 30,
      discardedAmount: 0,
      hpBefore: 40,
      hpAfter: 70,
    });
    expect(healApplied.stateDelta).toEqual({
      units: { [createBattleUnitId("TARGET")]: { hp: { before: 40, after: 70 } } },
    });
  });

  it("UT-R-HEAL-01-002 (BOUNDARY): SKILL_POWER heals the healer's attack times the power, not the raw power value", () => {
    const healer = unit("HEALER", "ALLY", { currentHp: 100, maximumHp: 100, attack: 200 });
    const target = unit("TARGET", "ALLY", { currentHp: 10, maximumHp: 500 });
    const action = healAction("ACT_HEAL", {
      formula: { kind: "SKILL_POWER", power: 0.65 },
      overheal: "DISCARD",
      distribution: "NONE",
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      action,
      [healer, target],
      context(recorder, rootEventId),
    );

    const healed = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(healed.currentHp).toBe(140);
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      formulaResult: 130,
      healAmount: 130,
    });
  });

  it("UT-R-HEAL-01-003 (BOUNDARY): overheal DISCARD caps HP at the current maximum and reports the discarded amount", () => {
    const healer = unit("HEALER", "ALLY");
    const target = unit("TARGET", "ALLY", { currentHp: 95, maximumHp: 100 });
    const action = healAction("ACT_HEAL", {
      formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
      overheal: "DISCARD",
      distribution: "NONE",
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      action,
      [healer, target],
      context(recorder, rootEventId),
    );

    const healed = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(healed.currentHp).toBe(100);
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      healAmount: 30,
      appliedAmount: 5,
      discardedAmount: 25,
    });
  });

  it("UT-R-HEAL-01-004 (BOUNDARY): a fractional heal amount is truncated once, immediately before it is applied", () => {
    const healer = unit("HEALER", "ALLY");
    const target = unit("TARGET", "ALLY", { currentHp: 10, maximumHp: 101 });
    const action = healAction("ACT_HEAL", {
      formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.105 },
      overheal: "DISCARD",
      distribution: "NONE",
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      action,
      [healer, target],
      context(recorder, rootEventId),
    );

    const healed = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    // 101 * 0.105 = 10.605 -> truncated to 10
    expect(healed.currentHp).toBe(20);
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      formulaResult: 10.605,
      healAmount: 10,
    });
  });

  it("UT-R-HEAL-01-005 (NEGATIVE): a negative formula result heals 0 and never reduces HP", () => {
    const healer = unit("HEALER", "ALLY");
    const target = unit("TARGET", "ALLY", { currentHp: 40, maximumHp: 100 });
    const action = healAction("ACT_HEAL", {
      formula: { kind: "CONSTANT", value: -25 },
      overheal: "DISCARD",
      distribution: "NONE",
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      action,
      [healer, target],
      context(recorder, rootEventId),
    );

    const healed = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(healed.currentHp).toBe(40);
    expect(result.changed).toBe(false);
    const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({ healAmount: 0, appliedAmount: 0 });
    expect(healApplied.stateDelta).toBeUndefined();
  });

  it("UT-R-HEAL-01-006 (NEGATIVE): a defeated target is never healed back to life", () => {
    const healer = unit("HEALER", "ALLY");
    const target = unit("TARGET", "ALLY", { currentHp: 0, maximumHp: 100 });
    const action = healAction("ACT_HEAL", {
      formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.5 },
      overheal: "DISCARD",
      distribution: "NONE",
    });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      action,
      [healer, target],
      context(recorder, rootEventId),
    );

    const healed = result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!;
    expect(healed.currentHp).toBe(0);
    expect(result.changed).toBe(false);
    expect(recorder.getEvents().some((e) => e.eventType === "HealApplied")).toBe(false);
  });
});
