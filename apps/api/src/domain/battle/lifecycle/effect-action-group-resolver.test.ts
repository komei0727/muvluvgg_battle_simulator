import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "./effect-action-group-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { DurationDefinition } from "../../catalog/definitions/duration-definition.js";
import type { RandomSource } from "../../ports/random-source.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 10 };

function unit(id: string, side: Side, overrides: Partial<BattleUnit> = {}): BattleUnit {
  const position: FormationPosition = { column: "LEFT", row: "FRONT" };
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 20,
      defense: 10,
      criticalRate: 0,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

function damageAction(id: string, hitCount = 1): EffectActionDefinition {
  return {
    kind: "DAMAGE",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      damageType: "PHYSICAL",
      formula: { kind: "SKILL_POWER", power: 1 },
      hitCount,
      critical: { mode: "PREVENTED" },
      accuracy: { mode: "NORMAL" },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
      damageModifiers: [],
      link: { enabled: false },
    },
  };
}

function statModAction(id: string): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      stat: "ATTACK",
      valueType: "FIXED",
      formula: { kind: "CONSTANT", value: 20 },
      stacking: { mode: "STACKABLE" },
      duration: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

function markerAction(
  id: string,
  markerId: ReturnType<typeof createMarkerId>,
): EffectActionDefinition {
  return {
    kind: "APPLY_MARKER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      markerId,
      stack: { policy: "ADD", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
  };
}

function removeMarkerAction(
  id: string,
  markerId: ReturnType<typeof createMarkerId>,
): EffectActionDefinition {
  return {
    kind: "REMOVE_MARKER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: { markerId },
  };
}

function cooldownManipulationAction(
  id: string,
  targetSkillDefinitionId: ReturnType<typeof createSkillDefinitionId>,
): EffectActionDefinition {
  return {
    kind: "COOLDOWN_MANIPULATION",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: { targetSkillDefinitionId, operation: "RESET" },
  };
}

const NO_RANDOM: RandomSource = {
  next(): number {
    throw new Error("random should not be consumed by critical.mode: PREVENTED");
  },
};

const EMPTY_DEFINITIONS: Omit<BattleDefinitions, "effectActions"> = {
  activeSkillsByUnit: new Map(),
  exSkillByUnit: new Map(),
  unitDefinitions: new Map(),
  skillDefinitions: new Map(),
};

function contextFor(
  actor: BattleUnit,
  effectActions: BattleDefinitions["effectActions"],
  recorder: EventRecorder,
  rootEventId: string,
  onFactEventForPassiveChain?: EffectActionGroupContext["onFactEventForPassiveChain"],
): EffectActionGroupContext {
  return {
    definitions: { ...EMPTY_DEFINITIONS, effectActions },
    actorId: actor.battleUnitId,
    random: NO_RANDOM,
    recorder,
    turnNumber: 1,
    cycleNumber: 0,
    skillUseId: recorder.nextSkillUseId(),
    actionScope: recorder.nextResolutionScopeId(),
    rootEventId: rootEventId as never,
    parentEventId: rootEventId as never,
    skillDefinitionId: createSkillDefinitionId("SKL_TEST"),
    ...(onFactEventForPassiveChain !== undefined ? { onFactEventForPassiveChain } : {}),
  };
}

function seedRecorder(): { recorder: EventRecorder; rootEventId: string } {
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

function singleActionStep(
  stepIndex: number,
  satisfied: boolean,
  targetBattleUnitId: BattleUnit["battleUnitId"],
  effectActionDefinitionId: EffectActionDefinition["effectActionDefinitionId"],
): EffectSequencePlan["steps"][number] {
  return {
    stepIndex,
    stepKind: "ACTION",
    conditionKind: satisfied ? "TRUE" : "NOT",
    satisfied,
    applications: satisfied
      ? [
          {
            targetBattleUnitId,
            effectActionDefinitionId,
            hits: [{ targetBattleUnitId, effectActionDefinitionId, hitIndex: 1 }],
          },
        ]
      : [],
  };
}

describe("applyEffectActionGroups", () => {
  it("UT-R-SKL-06-008: a satisfied ACTION step emits EffectStepStarting/EffectActionStarting/EffectActionCompleted(APPLIED)/EffectStepCompleted in order", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor, enemy], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "UnitBeingAttacked",
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageCalculated",
      "DamageApplied",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expect(result.resolvedCount).toBe(1);
    expect(result.interruptedCount).toBe(0);

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
    const stepCompleted = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectStepCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectStepCompleted" }
    >;
    expect(stepCompleted.payload).toEqual({ stepIndex: 0, resolvedActionCount: 1 });
  });

  it("UT-R-SKL-06-009: a step whose condition is false emits EffectStepStarting+EffectStepSkipped only, and a later step still resolves", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [
        singleActionStep(0, false, enemy.battleUnitId, attack.effectActionDefinitionId),
        singleActionStep(1, true, enemy.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
    };

    const before = recorder.getEvents().length;
    applyEffectActionGroups(plan, [actor, enemy], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectStepSkipped",
      "EffectStepStarting",
      "EffectActionStarting",
      "UnitBeingAttacked",
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageCalculated",
      "DamageApplied",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    const skipped = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectStepSkipped") as Extract<
      BattleDomainEvent,
      { eventType: "EffectStepSkipped" }
    >;
    expect(skipped.category).toBe("DIAGNOSTIC");
    expect(skipped.payload).toEqual({ stepIndex: 0, conditionKind: "NOT", result: false });
  });

  it("UT-R-SKL-01-004/UT-R-SKL-06-010: an actor defeated mid-step (self-damage) interrupts the remaining application in that step and skips later steps entirely, without EffectStepCompleted for the interrupted step", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
    const enemy = unit("ENEMY", "ENEMY");
    const selfHit = damageAction("ACT_SELF_HIT");
    const otherHit = damageAction("ACT_OTHER_HIT");
    const effectActions = new Map([
      [selfHit.effectActionDefinitionId, selfHit],
      [otherHit.effectActionDefinitionId, otherHit],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [
        {
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          applications: [
            {
              targetBattleUnitId: actor.battleUnitId,
              effectActionDefinitionId: selfHit.effectActionDefinitionId,
              hits: [
                {
                  targetBattleUnitId: actor.battleUnitId,
                  effectActionDefinitionId: selfHit.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            },
            {
              targetBattleUnitId: enemy.battleUnitId,
              effectActionDefinitionId: otherHit.effectActionDefinitionId,
              hits: [
                {
                  targetBattleUnitId: enemy.battleUnitId,
                  effectActionDefinitionId: otherHit.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            },
          ],
        },
        singleActionStep(1, true, enemy.battleUnitId, otherHit.effectActionDefinitionId),
      ],
      targetUnitIds: [actor.battleUnitId, enemy.battleUnitId],
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor, enemy], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    // step 0: EffectStepStarting → EffectActionStarting(selfHit) → ... →
    // DamageApplied → UnitDefeated → EffectActionCompleted(selfHit) — no
    // EffectStepCompleted (interrupted), and step 1 never starts.
    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "UnitBeingAttacked",
      "HitConfirmed",
      "CriticalCheckResolved",
      "DamageCalculated",
      "DamageApplied",
      "UnitDefeated",
      "EffectActionCompleted",
    ]);
    expect(emitted).not.toContain("EffectStepCompleted");

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");

    // resolvedCount: 1 hit (the lethal self-hit). interruptedCount: 1 (the
    // other-target hit in the same step) + 1 (step 1's hit) = 2.
    expect(result.resolvedCount).toBe(1);
    expect(result.interruptedCount).toBe(2);
  });

  it("UT-R-SKL-06-011: onFactEventForPassiveChain is invoked for FACT/TIMING events (not DIAGNOSTIC), and its returned units replace the working state", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY", { currentHp: 100 });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const observedEventTypes: string[] = [];
    // Simulate a PS that heals the enemy by 1 HP every time it observes a
    // non-DIAGNOSTIC event, to prove the hook's returned units are threaded
    // through to subsequent processing.
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observedEventTypes.push(event.eventType);
      return units.map((u) =>
        u.battleUnitId === enemy.battleUnitId ? { ...u, currentHp: u.currentHp + 1 } : u,
      );
    });
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    expect(observedEventTypes).not.toContain("EffectStepSkipped");
    expect(observedEventTypes).toContain("EffectStepStarting");
    expect(observedEventTypes).toContain("EffectActionStarting");
    expect(observedEventTypes).toContain("EffectActionCompleted");
    expect(observedEventTypes).toContain("EffectStepCompleted");

    // Each observation healed the enemy by 1: the hook fired at least 6 times
    // (EffectStepStarting, EffectActionStarting, HitConfirmed,
    // CriticalCheckResolved, DamageCalculated, DamageApplied,
    // EffectActionCompleted, EffectStepCompleted) before the 10-damage hit
    // landed, so the enemy's final HP reflects both the damage and the heals.
    const finalEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    const expectedHp = 100 - 10 + observedEventTypes.length;
    expect(finalEnemy.currentHp).toBe(expectedHp);
  });

  it("PR #142レビュー[P2]: EffectActionCompleted.parentEventId (DAMAGE) points to the actual last event (DamageApplied), not EffectActionStarting", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    const events = recorder.getEvents();
    const damageApplied = events.find((e) => e.eventType === "DamageApplied")!;
    const starting = events.find((e) => e.eventType === "EffectActionStarting")!;
    const completed = events.find((e) => e.eventType === "EffectActionCompleted")!;
    expect(completed.parentEventId).toBe(damageApplied.eventId);
    expect(completed.parentEventId).not.toBe(starting.eventId);
  });

  it("PR #142レビュー[P2]: EffectActionCompleted.parentEventId (DAMAGE, lethal) points to UnitDefeated when the hit is lethal", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
    const enemy = unit("ENEMY", "ENEMY");
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(enemy, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, actor.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    const events = recorder.getEvents();
    const unitDefeated = events.find((e) => e.eventType === "UnitDefeated")!;
    const completed = events.find((e) => e.eventType === "EffectActionCompleted")!;
    expect(completed.parentEventId).toBe(unitDefeated.eventId);
  });

  it("PR #142レビュー[P2]: EffectActionCompleted.parentEventId (COOLDOWN_MANIPULATION) points to the actual last event (CooldownCompleted), not EffectActionStarting", () => {
    const targetSkillId = createSkillDefinitionId("SKL_TARGET");
    const actor = unit("ACTOR", "ALLY", {
      cooldowns: { [targetSkillId]: { unit: "ACTION", remaining: 2 } },
    });
    const reset = cooldownManipulationAction("ACT_RESET", targetSkillId);
    const effectActions = new Map([[reset.effectActionDefinitionId, reset]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, actor.battleUnitId, reset.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
    };

    applyEffectActionGroups(plan, [actor], context);

    const events = recorder.getEvents();
    const cooldownCompleted = events.find((e) => e.eventType === "CooldownCompleted")!;
    const starting = events.find((e) => e.eventType === "EffectActionStarting")!;
    const completed = events.find((e) => e.eventType === "EffectActionCompleted")!;
    expect(completed.parentEventId).toBe(cooldownCompleted.eventId);
    expect(completed.parentEventId).not.toBe(starting.eventId);
  });

  it("UT-R-EFF-01-021 (R-EFF-01, real lifecycle wiring): an APPLY_STAT_MOD ACTION step grants an AppliedEffect through the real Catalog -> EffectSequence -> AppliedEffect -> event pipeline, emitting EffectApplied before EffectActionCompleted(APPLIED)", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const statMod = statModAction("ACT_ATK_UP");
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, statMod.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor, enemy], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "EffectApplied",
      "CombatStatChanged",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expect(result.resolvedCount).toBe(1);
    expect(result.interruptedCount).toBe(0);

    const grantedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(grantedTarget.appliedEffects).toHaveLength(1);
    expect(grantedTarget.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: statMod.effectActionDefinitionId,
      sourceId: actor.battleUnitId,
      targetId: enemy.battleUnitId,
      duplicate: true,
      magnitude: 20,
      appliedTurnNumber: 1,
    });

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied.payload.effectInstanceId).toBe(
      grantedTarget.appliedEffects[0]!.effectInstanceId,
    );

    const combatStatChanged = recorder
      .getEvents()
      .find((e) => e.eventType === "CombatStatChanged") as Extract<
      BattleDomainEvent,
      { eventType: "CombatStatChanged" }
    >;
    expect(combatStatChanged.payload).toMatchObject({
      battleUnitId: enemy.battleUnitId,
      stat: "ATTACK",
      before: 20,
      after: 40,
      reason: "EFFECT_APPLIED",
    });
    expect(combatStatChanged.parentEventId).toBe(applied.eventId);

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
    expect(completed.parentEventId).toBe(combatStatChanged.eventId);
  });

  it("UT-R-EFF-01-022 (R-EFF-01, mirrors UT-R-SKL-06-011): onFactEventForPassiveChain is invoked for the EffectApplied event an APPLY_STAT_MOD grant records, not just DAMAGE/COOLDOWN_MANIPULATION's own hit-unit events", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const statMod = statModAction("ACT_ATK_UP");
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const observedEventTypes: string[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observedEventTypes.push(event.eventType);
      return units;
    });
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, statMod.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(observedEventTypes).toContain("EffectApplied");
  });

  it("UT-R-NUM-04-027 (real lifecycle wiring): an APPLY_STAT_MOD formula can use any FormulaKind now that the general FormulaEvaluator is wired in, not just CONSTANT", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const statMod: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_UP_RATIO"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: {
          kind: "STAT_RATIO",
          source: { kind: "SKILL_SOURCE" },
          stat: "ATTACK",
          ratio: 0.5,
        },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "TURN", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, statMod.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    // actor.combatStats.attack = 20; STAT_RATIO(SKILL_SOURCE, ATTACK, 0.5) = 10.
    const grantedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(grantedTarget.appliedEffects[0]).toMatchObject({ magnitude: 10 });
  });

  it("UT-R-EFF-07-013 (レビュー再々指摘[P1]、PR #209、実Catalog ACT_MERU_FLATSPIN_PS1_ATK_UP相当): a NEXT_OUTGOING_ATTACK-consumed ATTACK buff still boosts the damage of the very attack that consumes it, then is actually removed afterward", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const attack = damageAction("ACT_ATTACK");
    // 実Catalog `ACT_MERU_FLATSPIN_PS1_ATK_UP` 相当: ATTACK +40%(RATIO)、
    // NEXT_OUTGOING_ATTACK消費(maxCount 1)。
    const consumedAtkBuffId = createEffectActionDefinitionId("ACT_ATK_BUFF_CONSUMED");
    const consumedAtkBuffDuration: DurationDefinition = {
      dispellable: true,
      linkedEffectGroupId: null,
      consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
    };
    const consumedAtkBuff: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: consumedAtkBuffId,
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0.4 },
        stacking: { mode: "STACKABLE" },
        duration: consumedAtkBuffDuration,
      },
    };
    // `grantEffect`/`recalculateCombatStats`が既に適用済みの状態を模す
    // （`attack: 20`の基準値に対し+40%で28）。
    const buffInstance: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("buff-1"),
      effectActionDefinitionId: consumedAtkBuffId,
      kindKey: effectKindKeyFromDefinitionId(consumedAtkBuffId),
      duplicate: true,
      sourceId: actor.battleUnitId,
      targetId: actor.battleUnitId,
      magnitude: 0.4,
      duration: {
        definition: consumedAtkBuffDuration,
        consumptionRemaining: 1,
      },
      appliedTurnNumber: 1,
    };
    const actorWithBuff: BattleUnit = {
      ...actor,
      combatStats: { ...actor.combatStats, attack: 28 },
      appliedEffects: [buffInstance],
    };
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [consumedAtkBuff.effectActionDefinitionId, consumedAtkBuff],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actorWithBuff, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const result = applyEffectActionGroups(plan, [actorWithBuff, enemy], context);

    // 消費させた本人の攻撃自身が、まだ除去されていないバフの補正込みの
    // attack(28)を使って計算されている。
    const damageCalculated = recorder
      .getEvents()
      .find((e) => e.eventType === "DamageCalculated") as Extract<
      BattleDomainEvent,
      { eventType: "DamageCalculated" }
    >;
    expect(damageCalculated.payload.attackerAttack).toBe(28);

    // その後、当該EffectActionの解決完了までにバフは実際に除去され、
    // combatStatsも基準値(20)へ戻る。
    const finalActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(finalActor.appliedEffects).toHaveLength(0);
    expect(finalActor.combatStats.attack).toBe(20);

    const eventTypes = recorder.getEvents().map((e) => e.eventType);
    expect(eventTypes).toContain("EffectExpired");
    expect(eventTypes).toContain("CombatStatChanged");
    expect(eventTypes.indexOf("DamageApplied")).toBeLessThan(eventTypes.indexOf("EffectExpired"));
    expect(result.interruptedCount).toBe(0);
  });

  describe("R-ACTN-01 #2: an already-defeated target is skipped for every EffectAction kind (RES-002, Issue #174)", () => {
    it("UT-R-ACTN-01-001: APPLY_STAT_MOD against an already-defeated target grants no AppliedEffect and completes as SKIPPED", () => {
      const actor = unit("ACTOR", "ALLY");
      const defeatedEnemy = unit("ENEMY", "ENEMY", { currentHp: 0 });
      const statMod = statModAction("ACT_ATK_UP");
      const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, defeatedEnemy.battleUnitId, statMod.effectActionDefinitionId),
        ],
        targetUnitIds: [defeatedEnemy.battleUnitId],
      };

      const before = recorder.getEvents().length;
      const result = applyEffectActionGroups(plan, [actor, defeatedEnemy], context);
      const emitted = recorder
        .getEvents()
        .slice(before)
        .map((e) => e.eventType);

      expect(emitted).toEqual([
        "EffectStepStarting",
        "EffectActionStarting",
        "EffectActionCompleted",
        "EffectStepCompleted",
      ]);
      expect(result.resolvedCount).toBe(1);
      expect(result.interruptedCount).toBe(0);

      const target = result.units.find((u) => u.battleUnitId === defeatedEnemy.battleUnitId)!;
      expect(target.appliedEffects).toHaveLength(0);

      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("SKIPPED");
    });

    it("UT-R-ACTN-01-002: APPLY_MARKER against an already-defeated target grants no MarkerState and completes as SKIPPED", () => {
      const actor = unit("ACTOR", "ALLY");
      const defeatedEnemy = unit("ENEMY", "ENEMY", { currentHp: 0 });
      const markerId = createMarkerId("MARKER_TEST");
      const apply = markerAction("ACT_APPLY_MARKER", markerId);
      const effectActions = new Map([[apply.effectActionDefinitionId, apply]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, defeatedEnemy.battleUnitId, apply.effectActionDefinitionId),
        ],
        targetUnitIds: [defeatedEnemy.battleUnitId],
      };

      const result = applyEffectActionGroups(plan, [actor, defeatedEnemy], context);

      const target = result.units.find((u) => u.battleUnitId === defeatedEnemy.battleUnitId)!;
      expect(target.markerStates).toHaveLength(0);
      expect(recorder.getEvents().some((e) => e.eventType === "MarkerApplied")).toBe(false);

      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("SKIPPED");
    });

    it("UT-R-ACTN-01-003: REMOVE_MARKER against an already-defeated target leaves its existing marker untouched and completes as SKIPPED (not APPLIED)", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const markerId = createMarkerId("MARKER_TEST");
      const setup = seedRecorder();
      const granted = applyMarker(
        {
          recorder: setup.recorder,
          turnNumber: 1,
          cycleNumber: 0,
          resolutionScopeId: setup.recorder.nextResolutionScopeId(),
          rootEventId: setup.rootEventId as never,
        },
        [actor, enemy],
        {
          markerId,
          sourceId: actor.battleUnitId,
          targetId: enemy.battleUnitId,
          stackPolicy: "ADD",
          stackMax: null,
          durationDefinition: { dispellable: true, linkedEffectGroupId: null },
        },
        setup.rootEventId as never,
      );
      const grantedEnemy = granted.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      const defeatedEnemy: BattleUnit = { ...grantedEnemy, currentHp: 0 };
      const remove = removeMarkerAction("ACT_REMOVE_MARKER", markerId);
      const effectActions = new Map([[remove.effectActionDefinitionId, remove]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, defeatedEnemy.battleUnitId, remove.effectActionDefinitionId),
        ],
        targetUnitIds: [defeatedEnemy.battleUnitId],
      };

      const result = applyEffectActionGroups(plan, [actor, defeatedEnemy], context);

      const target = result.units.find((u) => u.battleUnitId === defeatedEnemy.battleUnitId)!;
      expect(target.markerStates).toHaveLength(1);
      expect(recorder.getEvents().some((e) => e.eventType === "MarkerRemoved")).toBe(false);

      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("SKIPPED");
    });

    it("UT-R-ACTN-01-004: COOLDOWN_MANIPULATION targeting an already-defeated unit performs no cooldown change and completes as SKIPPED", () => {
      const actor = unit("ACTOR", "ALLY");
      const targetSkillId = createSkillDefinitionId("SKL_TARGET");
      const defeatedEnemy = unit("ENEMY", "ENEMY", {
        currentHp: 0,
        cooldowns: { [targetSkillId]: { unit: "ACTION", remaining: 2 } },
      });
      const reset = cooldownManipulationAction("ACT_RESET", targetSkillId);
      const effectActions = new Map([[reset.effectActionDefinitionId, reset]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, defeatedEnemy.battleUnitId, reset.effectActionDefinitionId),
        ],
        targetUnitIds: [defeatedEnemy.battleUnitId],
      };

      const result = applyEffectActionGroups(plan, [actor, defeatedEnemy], context);

      const target = result.units.find((u) => u.battleUnitId === defeatedEnemy.battleUnitId)!;
      expect(target.cooldowns[targetSkillId]).toEqual({ unit: "ACTION", remaining: 2 });
      expect(recorder.getEvents().some((e) => e.eventType === "CooldownReduced")).toBe(false);

      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("SKIPPED");
    });

    it("UT-R-ACTN-01-005: APPLY_MARKER against a target that is alive at application time still applies normally (this check does not fire on live targets)", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const markerId = createMarkerId("MARKER_TEST");
      const apply = markerAction("ACT_APPLY_MARKER", markerId);
      const effectActions = new Map([[apply.effectActionDefinitionId, apply]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [singleActionStep(0, true, enemy.battleUnitId, apply.effectActionDefinitionId)],
        targetUnitIds: [enemy.battleUnitId],
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      expect(target.markerStates).toHaveLength(1);
      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("APPLIED");
    });
  });
});
