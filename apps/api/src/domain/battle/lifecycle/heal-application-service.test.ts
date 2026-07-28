import { describe, expect, it } from "vitest";
import { applyHealAction } from "./heal-application-service.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createSkillUseId } from "../../shared/event-ids.js";
import { recordDamageResult, type DamageResultRegistry } from "../skill/formula-evaluator.js";
import { DomainValidationError } from "../../shared/errors.js";
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
  onFactEventForPassiveChain?: NonNullable<
    Parameters<typeof applyHealAction>[4]["onFactEventForPassiveChain"]
  >,
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
    ...(onFactEventForPassiveChain !== undefined ? { onFactEventForPassiveChain } : {}),
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

/**
 * R-HEAL-04 回復リンク（`M7-005-HEAL-LINK`、Issue #229）。production例は
 * `SKL_ELENA_MOODMAKER_AS1`「対象が得られる回復効果を100%自身に転送する」。
 * `applyOneHeal`（即時回復・継続回復が共有するR-HEAL-01の手順そのもの）が転送を
 * 行うため、ここでの検証は`APPLY_CONTINUOUS_HEAL`の発火にもそのまま及ぶ。
 */
describe("applyHealAction with healing links (R-HEAL-04, M7-005-HEAL-LINK Issue #229)", () => {
  function link(
    id: string,
    transferToUnitId: string,
    transferRate: number,
    holderId = "TARGET",
  ): AppliedEffect {
    return {
      effectInstanceId: `B_1:effect:${id}` as AppliedEffect["effectInstanceId"],
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      kindKey: id as AppliedEffect["kindKey"],
      duplicate: true,
      sourceId: createBattleUnitId(transferToUnitId),
      targetId: createBattleUnitId(holderId),
      magnitude: transferRate,
      healingLink: { transferToUnitId: createBattleUnitId(transferToUnitId), transferRate },
      duration: {
        definition: { dispellable: true, linkedEffectGroupId: null },
      },
      appliedTurnNumber: 1,
    };
  }

  function plainHeal(ratio: number): Extract<EffectActionDefinition, { kind: "HEAL" }> {
    return healAction("ACT_HEAL", {
      formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio },
      overheal: "DISCARD",
      distribution: "NONE",
    });
  }

  it("UT-R-HEAL-04-005: a 100% healing link moves the whole heal to the transfer destination and leaves the holder's HP unchanged", () => {
    const healer = unit("HEALER", "ALLY", { currentHp: 100, maximumHp: 100 });
    const destination = unit("DEST", "ALLY", { currentHp: 40, maximumHp: 100 });
    const holder = { ...unit("TARGET", "ENEMY", { currentHp: 50, maximumHp: 100 }) };
    const linked: BattleUnit = { ...holder, appliedEffects: [link("ACT_LINK", "DEST", 1)] };
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, destination, linked],
      context(recorder, rootEventId),
    );

    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(50);
    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      70,
    );
    const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
    expect(healApplied.payload).toMatchObject({
      targetUnitId: createBattleUnitId("TARGET"),
      healAmount: 30,
      transferredAmount: 30,
      appliedAmount: 0,
      discardedAmount: 0,
    });
    expect(healApplied.stateDelta).toBeUndefined();
    const transferred = recorder.getEvents().find((e) => e.eventType === "HealingTransferred")!;
    expect(transferred.category).toBe("FACT");
    expect(transferred.parentEventId).toBe(healApplied.eventId);
    expect(transferred.payload).toMatchObject({
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_LINK"),
      fromUnitId: createBattleUnitId("TARGET"),
      toUnitId: createBattleUnitId("DEST"),
      transferRate: 1,
      transferredAmount: 30,
      appliedAmount: 30,
      discardedAmount: 0,
      hpBefore: 40,
      hpAfter: 70,
    });
    expect(transferred.stateDelta).toEqual({
      units: { [createBattleUnitId("DEST")]: { hp: { before: 40, after: 70 } } },
    });
    expect(result.changed).toBe(true);
  });

  it("UT-R-HEAL-04-006: a partial healing link splits the heal, truncating the transferred share once (R-NUM-02)", () => {
    const healer = unit("HEALER", "ALLY");
    const destination = unit("DEST", "ALLY", { currentHp: 40, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 10, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "DEST", 0.5)],
    };
    const { recorder, rootEventId } = seedRecorder();

    // heal 25 -> truncate(25 * 0.5) = 12 transferred, 13 retained
    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.25),
      [healer, destination, linked],
      context(recorder, rootEventId),
    );

    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(23);
    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      52,
    );
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      healAmount: 25,
      transferredAmount: 12,
      appliedAmount: 13,
    });
    expect(
      recorder.getEvents().find((e) => e.eventType === "HealingTransferred")!.payload,
    ).toMatchObject({ transferredAmount: 12, appliedAmount: 12 });
  });

  it("UT-R-HEAL-04-007 (BOUNDARY): multiple links whose rates sum above 1 are capped in grant order, so the holder's retained amount never goes negative", () => {
    const healer = unit("HEALER", "ALLY");
    const first = unit("DEST_A", "ALLY", { currentHp: 10, maximumHp: 100 });
    const second = unit("DEST_B", "ALLY", { currentHp: 10, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 10, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK_A", "DEST_A", 0.8), link("ACT_LINK_B", "DEST_B", 0.8)],
    };
    const { recorder, rootEventId } = seedRecorder();

    // heal 30: first link takes truncate(30 * 0.8) = 24, second is capped at the
    // remaining 6 (not 24). Holder retains 0 and never loses HP.
    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, first, second, linked],
      context(recorder, rootEventId),
    );

    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(10);
    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST_A"))!.currentHp,
    ).toBe(34);
    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST_B"))!.currentHp,
    ).toBe(16);
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      healAmount: 30,
      transferredAmount: 30,
      appliedAmount: 0,
    });
    expect(
      recorder
        .getEvents()
        .filter((e) => e.eventType === "HealingTransferred")
        .map((e) => e.payload),
    ).toMatchObject([
      { toUnitId: createBattleUnitId("DEST_A"), transferredAmount: 24 },
      { toUnitId: createBattleUnitId("DEST_B"), transferredAmount: 6 },
    ]);
  });

  it("UT-R-HEAL-04-008 (BOUNDARY): a self-link is the identity — the holder keeps the heal and no HealingTransferred is emitted (SKL_ELENA_MOODMAKER_AS1 links itself)", () => {
    const healer = unit("HEALER", "ALLY");
    const linked: BattleUnit = {
      ...unit("TARGET", "ALLY", { currentHp: 50, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "TARGET", 1)],
    };
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, linked],
      context(recorder, rootEventId),
    );

    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(80);
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      transferredAmount: 0,
      appliedAmount: 30,
    });
    expect(recorder.getEvents().some((e) => e.eventType === "HealingTransferred")).toBe(false);
  });

  it("UT-R-HEAL-04-009 (BOUNDARY): mutually linked units terminate in one hop — the transferred healing does not re-transfer back (R-HEAL-04 re-link prohibition)", () => {
    const healer = unit("HEALER", "ALLY");
    const a: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 10, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK_A", "DEST", 1, "TARGET")],
    };
    const b: BattleUnit = {
      ...unit("DEST", "ENEMY", { currentHp: 10, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK_B", "TARGET", 1, "DEST")],
    };
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, a, b],
      context(recorder, rootEventId),
    );

    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(10);
    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      40,
    );
    expect(recorder.getEvents().filter((e) => e.eventType === "HealingTransferred")).toHaveLength(
      1,
    );
  });

  it("UT-R-HEAL-04-010 (NEGATIVE): a link whose destination is defeated does not establish, and the holder retains that share instead of the healing being lost", () => {
    const healer = unit("HEALER", "ALLY");
    const destination = unit("DEST", "ALLY", { currentHp: 0, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 50, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "DEST", 1)],
    };
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, destination, linked],
      context(recorder, rootEventId),
    );

    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(80);
    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      0,
    );
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      transferredAmount: 0,
      appliedAmount: 30,
    });
    expect(recorder.getEvents().some((e) => e.eventType === "HealingTransferred")).toBe(false);
  });

  it("UT-R-HEAL-04-011 (BOUNDARY): the transfer destination's maximum HP caps the transferred amount and the excess is discarded there, not returned to the holder", () => {
    const healer = unit("HEALER", "ALLY");
    const destination = unit("DEST", "ALLY", { currentHp: 95, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 50, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "DEST", 1)],
    };
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, destination, linked],
      context(recorder, rootEventId),
    );

    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(50);
    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      100,
    );
    expect(
      recorder.getEvents().find((e) => e.eventType === "HealingTransferred")!.payload,
    ).toMatchObject({ transferredAmount: 30, appliedAmount: 5, discardedAmount: 25 });
  });

  it("UT-R-HEAL-04-012 (BOUNDARY): a heal of 0 transfers nothing and emits no HealingTransferred, while HealApplied is still recorded (R-HEAL-01 audit trail)", () => {
    const healer = unit("HEALER", "ALLY");
    const destination = unit("DEST", "ALLY", { currentHp: 40, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 50, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "DEST", 1)],
    };
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0),
      [healer, destination, linked],
      context(recorder, rootEventId),
    );

    expect(result.changed).toBe(false);
    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      40,
    );
    expect(recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload).toMatchObject({
      healAmount: 0,
      transferredAmount: 0,
      appliedAmount: 0,
    });
    expect(recorder.getEvents().some((e) => e.eventType === "HealingTransferred")).toBe(false);
  });

  it("UT-R-HEAL-04-013 (NEGATIVE): a defeated link holder is not healed, so no transfer occurs and neither event is emitted", () => {
    const healer = unit("HEALER", "ALLY");
    const destination = unit("DEST", "ALLY", { currentHp: 40, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 0, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "DEST", 1)],
    };
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, destination, linked],
      context(recorder, rootEventId),
    );

    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      40,
    );
    expect(recorder.getEvents().some((e) => e.eventType === "HealApplied")).toBe(false);
    expect(recorder.getEvents().some((e) => e.eventType === "HealingTransferred")).toBe(false);
  });

  /**
   * PRレビュー指摘[P2]（PR #259）: `HealApplied`／各`HealingTransferred`のPS/Memory
   * 連鎖は、それぞれの発行直後・次の転送を適用する前に解決しなければならない。
   * 以下は連鎖callbackが観測したイベント順とその時点のHPを固定する。
   */
  function recordingChain(observedIds: readonly string[]) {
    const observations: { eventType: string; hp: Record<string, number> }[] = [];
    const callback = (
      event: { readonly eventType: string },
      units: readonly BattleUnit[],
    ): readonly BattleUnit[] => {
      observations.push({
        eventType: event.eventType,
        hp: Object.fromEntries(
          observedIds.map((id) => [
            id,
            units.find((u) => u.battleUnitId === createBattleUnitId(id))!.currentHp,
          ]),
        ),
      });
      return units;
    };
    return { observations, callback };
  }

  it("UT-R-HEAL-04-014: the HealApplied chain runs before the transfer is applied, so a reacting PS observes the pre-transfer HP, and the HealingTransferred chain runs after its own HP change", () => {
    const healer = unit("HEALER", "ALLY");
    const destination = unit("DEST", "ALLY", { currentHp: 40, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 50, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "DEST", 1)],
    };
    const { recorder, rootEventId } = seedRecorder();
    const { observations, callback } = recordingChain(["TARGET", "DEST"]);

    applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, destination, linked],
      context(recorder, rootEventId, new Map(), callback),
    );

    expect(observations).toEqual([
      // 転送前: 保持者は転送分を受け取らず（50のまま）、転送先も未受領（40のまま）。
      { eventType: "HealApplied", hp: { TARGET: 50, DEST: 40 } },
      // 転送後: 転送先のHP変化を適用してから連鎖する。
      { eventType: "HealingTransferred", hp: { TARGET: 50, DEST: 70 } },
    ]);
  });

  it("UT-R-HEAL-04-015: with two links, each transfer's chain resolves before the next transfer is applied", () => {
    const healer = unit("HEALER", "ALLY");
    const first = unit("DEST_A", "ALLY", { currentHp: 10, maximumHp: 100 });
    const second = unit("DEST_B", "ALLY", { currentHp: 10, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 10, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK_A", "DEST_A", 0.5), link("ACT_LINK_B", "DEST_B", 0.5)],
    };
    const { recorder, rootEventId } = seedRecorder();
    const { observations, callback } = recordingChain(["DEST_A", "DEST_B"]);

    applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, first, second, linked],
      context(recorder, rootEventId, new Map(), callback),
    );

    // heal 30 -> 15 to each destination, applied and chained one at a time.
    expect(observations).toEqual([
      { eventType: "HealApplied", hp: { DEST_A: 10, DEST_B: 10 } },
      { eventType: "HealingTransferred", hp: { DEST_A: 25, DEST_B: 10 } },
      { eventType: "HealingTransferred", hp: { DEST_A: 25, DEST_B: 25 } },
    ]);
  });

  it("UT-R-HEAL-04-016 (NEGATIVE): when the HealApplied chain defeats the transfer destination, the already-allocated transfer is not applied (no revival) and is recorded as fully discarded rather than returned to the holder", () => {
    const healer = unit("HEALER", "ALLY");
    const destination = unit("DEST", "ALLY", { currentHp: 40, maximumHp: 100 });
    const linked: BattleUnit = {
      ...unit("TARGET", "ENEMY", { currentHp: 50, maximumHp: 100 }),
      appliedEffects: [link("ACT_LINK", "DEST", 1)],
    };
    const { recorder, rootEventId } = seedRecorder();
    // `HealApplied`に反応したPSが転送先を戦闘不能にする状況を模す。
    const killDestinationOnHeal = (
      event: { readonly eventType: string },
      units: readonly BattleUnit[],
    ): readonly BattleUnit[] =>
      event.eventType === "HealApplied"
        ? units.map((u) =>
            u.battleUnitId === createBattleUnitId("DEST") ? { ...u, currentHp: 0 } : u,
          )
        : units;

    const result = applyHealAction(
      [hit("TARGET", "ACT_HEAL")],
      healer,
      plainHeal(0.3),
      [healer, destination, linked],
      context(recorder, rootEventId, new Map(), killDestinationOnHeal),
    );

    // 転送先は蘇生しない（R-HEAL-01「戦闘不能の対象は回復しない」）。
    expect(result.units.find((u) => u.battleUnitId === createBattleUnitId("DEST"))!.currentHp).toBe(
      0,
    );
    // 保持者へも戻さない（`HealApplied`のStateDeltaは既に確定済み、R-INT-03と同じ規約）。
    expect(
      result.units.find((u) => u.battleUnitId === createBattleUnitId("TARGET"))!.currentHp,
    ).toBe(50);
    const transferred = recorder.getEvents().find((e) => e.eventType === "HealingTransferred")!;
    expect(transferred.payload).toMatchObject({
      transferredAmount: 30,
      appliedAmount: 0,
      discardedAmount: 30,
      hpBefore: 0,
      hpAfter: 0,
    });
    expect(transferred.stateDelta).toBeUndefined();
  });
});

/**
 * G-10（`14_Catalog定義スキーマ.md`）／RES-003A（Issue #257）: `SUM_DAMAGE_DEALT`を
 * 参照するproduction HEAL 9件（`ACT_FLUTE_VAMPIRE_EX_SELF_HEAL`等）が実際に読む経路。
 */
describe("applyHealAction with DAMAGE_DEALT_RATIO(SUM_DAMAGE_DEALT) (G-10, RES-003A Issue #257)", () => {
  const SEQUENCE = createSkillUseId("SKILL_USE_SELF_HEAL");
  const OTHER_SEQUENCE = createSkillUseId("SKILL_USE_PASSIVE_CHAIN");

  function sumHealAction(): Extract<EffectActionDefinition, { kind: "HEAL" }> {
    return healAction("ACT_SUM_HEAL", {
      formula: { kind: "DAMAGE_DEALT_RATIO", sourceResult: "SUM_DAMAGE_DEALT", ratio: 0.6 },
      overheal: "DISCARD",
      distribution: "NONE",
    });
  }

  it("UT-R-HEAL-01-013: heals the summed damage this EffectSequence has dealt so far, not only its most recent DAMAGE result", () => {
    const healer = unit("HEALER", "ALLY", { currentHp: 10, maximumHp: 1000 });
    const { recorder, rootEventId } = seedRecorder();
    const damageResults: DamageResultRegistry = new Map();
    // 列攻撃100 + 条件付き追撃50 = 累計150（直前結果は50）。
    recordDamageResult(
      damageResults,
      healer.battleUnitId,
      createBattleUnitId("ENEMY"),
      100,
      SEQUENCE,
    );
    recordDamageResult(
      damageResults,
      healer.battleUnitId,
      createBattleUnitId("ENEMY"),
      50,
      SEQUENCE,
    );

    const result = applyHealAction(
      [hit("HEALER", "ACT_SUM_HEAL")],
      healer,
      sumHealAction(),
      [healer],
      { ...context(recorder, rootEventId), skillUseId: SEQUENCE, damageResults },
    );

    const healed = result.units.find((u) => u.battleUnitId === healer.battleUnitId)!;
    expect(healed.currentHp).toBe(10 + Math.floor(150 * 0.6));
  });

  it("UT-R-HEAL-01-014: excludes damage recorded under a different EffectSequence resolution (a PS chain firing inside the same action)", () => {
    const healer = unit("HEALER", "ALLY", { currentHp: 10, maximumHp: 1000 });
    const { recorder, rootEventId } = seedRecorder();
    const damageResults: DamageResultRegistry = new Map();
    recordDamageResult(
      damageResults,
      healer.battleUnitId,
      createBattleUnitId("ENEMY"),
      100,
      SEQUENCE,
    );
    recordDamageResult(
      damageResults,
      healer.battleUnitId,
      createBattleUnitId("ENEMY"),
      900,
      OTHER_SEQUENCE,
    );

    const result = applyHealAction(
      [hit("HEALER", "ACT_SUM_HEAL")],
      healer,
      sumHealAction(),
      [healer],
      { ...context(recorder, rootEventId), skillUseId: SEQUENCE, damageResults },
    );

    const healed = result.units.find((u) => u.battleUnitId === healer.battleUnitId)!;
    expect(healed.currentHp).toBe(10 + Math.floor(100 * 0.6));
  });

  it("UT-R-HEAL-01-015: heals 0 when this EffectSequence has produced no DAMAGE result yet (every damage step resolved to zero targets)", () => {
    const healer = unit("HEALER", "ALLY", { currentHp: 10, maximumHp: 1000 });
    const { recorder, rootEventId } = seedRecorder();

    const result = applyHealAction(
      [hit("HEALER", "ACT_SUM_HEAL")],
      healer,
      sumHealAction(),
      [healer],
      {
        ...context(recorder, rootEventId),
        skillUseId: SEQUENCE,
        damageResults: new Map() as DamageResultRegistry,
      },
    );

    expect(result.units.find((u) => u.battleUnitId === healer.battleUnitId)!.currentHp).toBe(10);
    expect(result.changed).toBe(false);
  });

  it("UT-R-HEAL-01-016 (NEGATIVE): rejects the reference when the heal resolves outside any EffectSequence (no registry wired)", () => {
    const healer = unit("HEALER", "ALLY", { currentHp: 10, maximumHp: 1000 });
    const { recorder, rootEventId } = seedRecorder();

    expect(() =>
      applyHealAction(
        [hit("HEALER", "ACT_SUM_HEAL")],
        healer,
        sumHealAction(),
        [healer],
        context(recorder, rootEventId),
      ),
    ).toThrow(DomainValidationError);
  });
});
