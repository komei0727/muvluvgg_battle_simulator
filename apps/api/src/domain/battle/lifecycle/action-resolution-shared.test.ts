import { describe, expect, it } from "vitest";
import {
  composeResourceGainRate,
  increaseExGauge,
  recordExtraGaugeOverflowDiscardedIfAny,
  recordResourceChangeIfAny,
  type ResourceChangeRecordContext,
} from "./action-resolution-shared.js";
import { EventRecorder } from "../events/event-recorder.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import {
  createEffectActionDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";

function unit(id: string, appliedEffects: readonly AppliedEffect[] = []): BattleUnit {
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
  const built = createBattleUnit(member, "ALLY", {
    maximumAp: 3,
    maximumPp: 3,
    maximumExtraGauge: 20,
  });
  return { ...built, appliedEffects };
}

function resourceGainModAction(id: string, rate: number): EffectActionDefinition {
  return {
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    kind: "APPLY_RESOURCE_GAIN_MOD",
    payload: {
      resource: "EX_GAUGE",
      rateDelta: { kind: "CONSTANT", value: rate },
      stacking: { mode: "STACKABLE" },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
    requiredCapabilities: [],
    metadata: { tags: [] },
  };
}

function resourceGainModEffect(
  id: string,
  targetId: ReturnType<typeof createBattleUnitId>,
  definitionId: ReturnType<typeof createEffectActionDefinitionId>,
  magnitude: number,
): AppliedEffect {
  return {
    effectInstanceId: createEffectInstanceId(id),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    categories: ["BUFF"],
    duplicate: true,
    sourceId: targetId,
    targetId,
    magnitude,
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

function contextOf(recorder: EventRecorder): ResourceChangeRecordContext {
  return {
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    resolutionScopeId: recorder.nextResolutionScopeId(),
    rootEventId: recorder.record({
      eventType: "TurnStarted",
      category: "FACT",
      turnNumber: 1,
      cycleNumber: 0,
      resolutionScopeId: recorder.nextResolutionScopeId(),
      payload: { turnNumber: 1 },
    }).eventId,
  };
}

describe("recordResourceChangeIfAny (R-ACT-04, M7-002 Issue #185)", () => {
  it("UT-R-ACT-04-015: ResourceChanged carries baseDelta equal to delta when no RESOURCE_GAIN_MOD is involved (plain AP/PP consumption)", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const context = contextOf(recorder);
    const actorId = createBattleUnitId("ACTOR");

    const eventId = recordResourceChangeIfAny(
      context,
      actorId,
      "AP",
      3,
      2,
      -1,
      "SKILL_COST",
      context.rootEventId,
      context.rootEventId,
    );

    const event = recorder
      .getEvents()
      .find((e) => e.eventType === "ResourceChanged" && e.eventId === eventId)!;
    expect(event.payload).toMatchObject({ before: 3, after: 2, delta: -1, baseDelta: -1 });
  });

  it("UT-R-ACT-04-005 (M7-002, Issue #185, HP_DIRECT_COST): a resource: HP change carries its StateDelta under the 'hp' key, not 'extraGauge'", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const context = contextOf(recorder);
    const actorId = createBattleUnitId("ACTOR");

    const eventId = recordResourceChangeIfAny(
      context,
      actorId,
      "HP",
      100,
      90,
      -10,
      "EFFECT_ACTION",
      context.rootEventId,
      context.rootEventId,
    );

    const event = recorder
      .getEvents()
      .find((e) => e.eventType === "ResourceChanged" && e.eventId === eventId)!;
    expect(event.stateDelta).toEqual({
      units: { [actorId]: { hp: { before: 100, after: 90 } } },
    });
  });

  it("UT-R-ACT-04-003: ResourceChanged's baseDelta can differ from delta (e.g. a RESOURCE_GAIN_MOD-boosted EX gain that still gets capacity-clamped)", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const context = contextOf(recorder);
    const actorId = createBattleUnitId("ACTOR");

    const eventId = recordResourceChangeIfAny(
      context,
      actorId,
      "EX_GAUGE",
      8,
      10,
      15,
      "EX_GAIN",
      context.rootEventId,
      context.rootEventId,
    );

    const event = recorder
      .getEvents()
      .find((e) => e.eventType === "ResourceChanged" && e.eventId === eventId)!;
    expect(event.payload).toMatchObject({ before: 8, after: 10, delta: 2, baseDelta: 15 });
  });
});

describe("recordExtraGaugeOverflowDiscardedIfAny (R-ACT-03/04, M7-002 Issue #185)", () => {
  it("UT-R-ACT-04-004: ExtraGaugeOverflowDiscarded carries baseDelta alongside requestedAmount/actualAmount/discardedAmount", () => {
    const recorder = new EventRecorder(createBattleId("B_1"));
    const context = contextOf(recorder);
    const actorId = createBattleUnitId("ACTOR");

    const eventId = recordExtraGaugeOverflowDiscardedIfAny(
      context,
      actorId,
      15,
      10,
      2,
      5,
      context.rootEventId,
    );

    const event = recorder
      .getEvents()
      .find((e) => e.eventType === "ExtraGaugeOverflowDiscarded" && e.eventId === eventId)!;
    expect(event.payload).toMatchObject({
      baseDelta: 15,
      requestedAmount: 10,
      actualAmount: 2,
      discardedAmount: 5,
    });
  });
});

describe("composeResourceGainRate (G-05, M7-002 Issue #185, APPLY_RESOURCE_GAIN_MOD)", () => {
  it("UT-R-ACT-04-006: sums the magnitude of every held APPLY_RESOURCE_GAIN_MOD instance matching the resource (stacking is STACKABLE-only)", () => {
    const buffDef = resourceGainModAction("ACT_EX_BUFF", 0.5);
    const secondBuffDef = resourceGainModAction("ACT_EX_BUFF_2", 0.2);
    const targetId = createBattleUnitId("ACTOR");
    const target = unit("ACTOR", [
      resourceGainModEffect("eff-1", targetId, buffDef.effectActionDefinitionId, 0.5),
      resourceGainModEffect("eff-2", targetId, secondBuffDef.effectActionDefinitionId, 0.2),
    ]);
    const effectActions = new Map([
      [buffDef.effectActionDefinitionId, buffDef],
      [secondBuffDef.effectActionDefinitionId, secondBuffDef],
    ]);

    expect(composeResourceGainRate(target, "EX_GAUGE", effectActions)).toBeCloseTo(0.7);
  });

  it("UT-R-ACT-04-007: ignores non-APPLY_RESOURCE_GAIN_MOD effects held alongside a real one (e.g. an unrelated APPLY_STAT_MOD)", () => {
    const exBuffDef = resourceGainModAction("ACT_EX_BUFF", 0.5);
    const statModDef: EffectActionDefinition = {
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_UP"),
      kind: "APPLY_STAT_MOD",
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: 10 },
        stacking: { mode: "STACKABLE", max: null },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
      requiredCapabilities: [],
      metadata: { tags: [] },
    };
    const targetId = createBattleUnitId("ACTOR");
    const target = unit("ACTOR", [
      resourceGainModEffect("eff-1", targetId, exBuffDef.effectActionDefinitionId, 0.5),
      resourceGainModEffect("eff-2", targetId, statModDef.effectActionDefinitionId, 0.9),
    ]);
    const effectActions = new Map([
      [exBuffDef.effectActionDefinitionId, exBuffDef],
      [statModDef.effectActionDefinitionId, statModDef],
    ]);

    expect(composeResourceGainRate(target, "EX_GAUGE", effectActions)).toBeCloseTo(0.5);
  });

  it("UT-R-ACT-04-008: returns 0 when the unit holds no matching effect", () => {
    const target = unit("ACTOR");
    expect(composeResourceGainRate(target, "EX_GAUGE", new Map())).toBe(0);
  });
});

describe("increaseExGauge with a RESOURCE_GAIN_MOD rate (M7-002, Issue #185)", () => {
  it("UT-R-ACT-04-009: a +50% rate increases the gain proportionally (baseDelta stays the raw amount)", () => {
    const actor: BattleUnit = { ...unit("ACTOR"), currentExtraGauge: 0, maximumExtraGauge: 20 };

    const result = increaseExGauge([actor], actor.battleUnitId, 4, 0.5);

    expect(result.before).toBe(0);
    expect(result.after).toBe(6);
    expect(result.baseDelta).toBe(4);
    expect(result.requestedAmount).toBe(6);
    expect(result.discardedAmount).toBe(0);
  });

  it("UT-R-ACT-04-010: a fractional rate-boosted request truncates exactly once, and requestedAmount === actualAmount + discardedAmount always holds even when clamped by capacity", () => {
    const actor: BattleUnit = { ...unit("ACTOR"), currentExtraGauge: 18, maximumExtraGauge: 20 };

    // baseDelta 3 * (1 + 0.3) = 3.9 raw request, truncated once to requestedAmount 3;
    // capacity only has room for 2 (18 -> 20), so 1 is discarded.
    const result = increaseExGauge([actor], actor.battleUnitId, 3, 0.3);

    expect(result.before).toBe(18);
    expect(result.after).toBe(20);
    expect(result.baseDelta).toBe(3);
    expect(result.requestedAmount).toBe(3);
    expect(result.discardedAmount).toBe(1);
    expect(result.discardedAmount).toBe(result.requestedAmount - (result.after - result.before));
  });

  it("UT-R-ACT-04-011: a negative rate (RESOURCE_GAIN_MOD debuff) reduces the gain", () => {
    const actor: BattleUnit = { ...unit("ACTOR"), currentExtraGauge: 0, maximumExtraGauge: 20 };

    const result = increaseExGauge([actor], actor.battleUnitId, 4, -0.5);

    expect(result.after).toBe(2);
    expect(result.baseDelta).toBe(4);
  });

  it("UT-R-ACT-04-014 (PRレビュー[P1] PR #254): a composed rate below -100% (e.g. three stacked -50% RESOURCE_GAIN_MOD debuffs, R-FRM-03 same-UnitDefinition multi-deployment) floors the gain at 0 instead of driving the gauge negative", () => {
    const actor: BattleUnit = { ...unit("ACTOR"), currentExtraGauge: 0, maximumExtraGauge: 20 };

    const result = increaseExGauge([actor], actor.battleUnitId, 4, -1.5);

    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
    expect(result.baseDelta).toBe(4);
    expect(result.requestedAmount).toBe(0);
    expect(result.discardedAmount).toBe(0);
  });
});
