import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
  type EffectActionGroupsResult,
} from "./effect-action-group-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { effectKindKeyFromDefinitionId, type AppliedEffect } from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { resolveSkillOrder, type EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import type {
  SkillDefinition,
  SkillResolutionDefinition,
} from "../../catalog/definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
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
import type { EffectStepDefinition } from "../../catalog/definitions/effect-sequence.js";
import { createTargetBindingId } from "../../catalog/definitions/catalog-ids.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import type { ConditionDefinition } from "../../catalog/definitions/condition-definition.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DomainValidationError } from "../../shared/errors.js";

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

/**
 * R-TGT-10（Issue #168レビュー[P2]）: `resolveSkillOrder`が実際に組み立てる
 * `EffectSequencePlan`を、この`applyEffectActionGroups`テストへ橋渡しするための
 * 最小`SkillDefinition`。`skill-resolution-service.test.ts`の同名ヘルパーと同じ形。
 */
function skillOf(resolution: SkillResolutionDefinition): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId("SKL_TEST"),
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    counterUpdates: [],
    resolution,
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Test", tags: [] },
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
  includeDefeated = false,
): EffectSequencePlan["steps"][number] {
  return {
    planKind: "ACTION_PLAN",
    stepIndex,
    stepKind: "ACTION",
    conditionKind: satisfied ? "TRUE" : "NOT",
    satisfied,
    actions: [{ effectActionDefinitionId }],
    applications: satisfied
      ? [
          {
            targetBattleUnitId,
            effectActionDefinitionId,
            includeDefeated,
            hits: [{ targetBattleUnitId, effectActionDefinitionId, hitIndex: 1 }],
          },
        ]
      : [],
  };
}

function expectCompleted(result: EffectActionGroupsResult, resolvedEffectCount: number): void {
  expect(result.outcome).toEqual({ status: "COMPLETED", resolvedEffectCount });
}

function expectInterrupted(
  result: EffectActionGroupsResult,
  resolvedEffectCount: number,
  unresolvedEffectCount: number,
): void {
  expect(result.outcome).toEqual({
    status: "INTERRUPTED",
    reason: "ACTOR_DEFEATED",
    resolvedEffectCount,
    unresolvedEffectCount,
  });
}

function deferredStep(
  stepIndex: number,
  definition: EffectStepDefinition,
): EffectSequencePlan["steps"][number] {
  return { planKind: "DEFERRED", stepIndex, stepKind: definition.kind, definition };
}

function actionOn(
  target: TargetReference,
  effectActionDefinitionId: EffectActionDefinition["effectActionDefinitionId"],
  condition: ConditionDefinition = { kind: "TRUE" },
): Extract<EffectStepDefinition, { kind: "ACTION" }> {
  return { kind: "ACTION", condition, target, actions: [{ effectActionDefinitionId }] };
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
      resolvedBindings: new Map(),
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
      "HitPointReduced",
      "DamageApplied",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);

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
      resolvedBindings: new Map(),
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
      "HitPointReduced",
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
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions: [
            { effectActionDefinitionId: selfHit.effectActionDefinitionId },
            { effectActionDefinitionId: otherHit.effectActionDefinitionId },
          ],
          applications: [
            {
              targetBattleUnitId: actor.battleUnitId,
              effectActionDefinitionId: selfHit.effectActionDefinitionId,
              includeDefeated: false,
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
              includeDefeated: false,
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
      resolvedBindings: new Map(),
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
      "HitPointReduced",
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

    // resolvedEffectCount: 1 hit (the lethal self-hit). unresolvedEffectCount:
    // 1 (the other-target hit abandoned within the same, currently-open
    // ACTION step). Step 1 was never entered (Issue #217 design point D2:
    // an unentered step/branch/iteration contributes 0, not a re-walked
    // estimate of its own hits).
    expectInterrupted(result, 1, 1);
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
      resolvedBindings: new Map(),
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
      resolvedBindings: new Map(),
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
      resolvedBindings: new Map(),
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
      resolvedBindings: new Map(),
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
      resolvedBindings: new Map(),
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
    expectCompleted(result, 1);

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
      resolvedBindings: new Map(),
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
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    // actor.combatStats.attack = 20; STAT_RATIO(SKILL_SOURCE, ATTACK, 0.5) = 10.
    const grantedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(grantedTarget.appliedEffects[0]).toMatchObject({ magnitude: 10 });
  });

  it("UT-CAP-TRIGGER-CONTEXT-009 (RES-005 review finding [P2]): a TRIGGER_TARGET Formula reads the unit's CURRENT state at evaluation time, not a stale snapshot from when the PS activated", () => {
    const actor = unit("ACTOR", "ALLY");
    // `defense: 0` so `SKILL_POWER power: 1` damage equals the attacker's
    // attack (20) exactly, with no rounding ambiguity.
    const triggerTarget = unit("TRIGGER_TARGET_UNIT", "ENEMY", {
      combatStats: {
        maximumHp: 100,
        attack: 20,
        defense: 0,
        criticalRate: 0,
        actionSpeed: 10,
        criticalDamageBonus: 0.5,
        affinityBonus: 0,
      },
    });
    const attack = damageAction("ACT_ATTACK");
    // Reads `TRIGGER_TARGET`'s CURRENT_HP_RATIO (ratio 1 => just currentHp) —
    // if the step below evaluates this using a `BattleUnit` snapshot resolved
    // once when the PS activated (before the DAMAGE step reduced its HP),
    // this reads the pre-damage 100. If it correctly re-resolves the current
    // `box.units` state at Formula-evaluation time, it reads the post-damage
    // 80 (100 - 20 attack, 0 defense).
    const hpRatioStatMod: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_HP_RATIO_BUFF"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TRIGGER_TARGET" }, ratio: 1 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "TURN", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [hpRatioStatMod.effectActionDefinitionId, hpRatioStatMod],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context: EffectActionGroupContext = {
      ...contextFor(actor, effectActions, recorder, rootEventId),
      triggerTargetUnitIds: [triggerTarget.battleUnitId],
    };
    const plan: EffectSequencePlan = {
      steps: [
        // Step 0: DAMAGE reduces triggerTarget's HP from 100 to 80.
        singleActionStep(0, true, triggerTarget.battleUnitId, attack.effectActionDefinitionId),
        // Step 1: APPLY_STAT_MOD on the actor, magnitude = triggerTarget's
        // CURRENT HP (post-step-0) via TRIGGER_TARGET.
        singleActionStep(1, true, actor.battleUnitId, hpRatioStatMod.effectActionDefinitionId),
      ],
      targetUnitIds: [triggerTarget.battleUnitId, actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, triggerTarget], context);

    const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updatedActor.appliedEffects[0]).toMatchObject({ magnitude: 80 });
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
      resolvedBindings: new Map(),
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
    expect(result.outcome.status).toBe("COMPLETED");
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
        resolvedBindings: new Map(),
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
      expectCompleted(result, 1);

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
        resolvedBindings: new Map(),
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
        resolvedBindings: new Map(),
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
        resolvedBindings: new Map(),
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
        resolvedBindings: new Map(),
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

    it("UT-R-ACTN-01-006: APPLY_STAT_MOD still applies to an already-defeated target when its TargetSelectorDefinition.includeDefeated is true (explicit override, PR #215 review finding [P2])", () => {
      const actor = unit("ACTOR", "ALLY");
      const defeatedEnemy = unit("ENEMY", "ENEMY", { currentHp: 0 });
      const statMod = statModAction("ACT_ATK_UP");
      const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(
            0,
            true,
            defeatedEnemy.battleUnitId,
            statMod.effectActionDefinitionId,
            true,
          ),
        ],
        targetUnitIds: [defeatedEnemy.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, defeatedEnemy], context);

      const target = result.units.find((u) => u.battleUnitId === defeatedEnemy.battleUnitId)!;
      expect(target.appliedEffects).toHaveLength(1);
      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("APPLIED");
    });

    it("UT-R-ACTN-01-010: DAMAGE against an already-defeated target still applies through the real pipeline (applyDamageAction) when TargetSelectorDefinition.includeDefeated is true (PR #215 re-review finding [P2])", () => {
      const actor = unit("ACTOR", "ALLY");
      const defeatedEnemy = unit("ENEMY", "ENEMY", { currentHp: 0 });
      const attack = damageAction("ACT_ATTACK");
      const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(
            0,
            true,
            defeatedEnemy.battleUnitId,
            attack.effectActionDefinitionId,
            true,
          ),
        ],
        targetUnitIds: [defeatedEnemy.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, defeatedEnemy], context);

      // Not skipped: the hit reached HitConfirmed/DamageCalculated/DamageApplied
      // instead of being silently dropped by the target-already-defeated check.
      const emitted = recorder.getEvents().map((e) => e.eventType);
      expect(emitted).toContain("HitConfirmed");
      expect(emitted).toContain("DamageCalculated");
      expect(emitted).toContain("DamageApplied");
      expectCompleted(result, 1);

      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("APPLIED");
    });

    it("UT-R-ACTN-01-007: REMOVE_MARKER against a live target with an existing marker actually removes it through the real pipeline and completes as APPLIED", () => {
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
      const remove = removeMarkerAction("ACT_REMOVE_MARKER", markerId);
      const effectActions = new Map([[remove.effectActionDefinitionId, remove]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, grantedEnemy.battleUnitId, remove.effectActionDefinitionId),
        ],
        targetUnitIds: [grantedEnemy.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, grantedEnemy], context);

      const target = result.units.find((u) => u.battleUnitId === grantedEnemy.battleUnitId)!;
      expect(target.markerStates).toHaveLength(0);
      expect(recorder.getEvents().some((e) => e.eventType === "MarkerRemoved")).toBe(true);

      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("APPLIED");
    });

    it("UT-R-ACTN-01-009: COOLDOWN_MANIPULATION against a live target with a non-zero remaining cooldown actually resets it through the real pipeline and completes as APPLIED", () => {
      const actor = unit("ACTOR", "ALLY");
      const targetSkillId = createSkillDefinitionId("SKL_TARGET");
      const enemy = unit("ENEMY", "ENEMY", {
        cooldowns: { [targetSkillId]: { unit: "ACTION", remaining: 2 } },
      });
      const reset = cooldownManipulationAction("ACT_RESET", targetSkillId);
      const effectActions = new Map([[reset.effectActionDefinitionId, reset]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [singleActionStep(0, true, enemy.battleUnitId, reset.effectActionDefinitionId)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      expect(target.cooldowns[targetSkillId]?.remaining).toBe(0);
      expect(recorder.getEvents().some((e) => e.eventType === "CooldownReduced")).toBe(true);
      expect(recorder.getEvents().some((e) => e.eventType === "CooldownCompleted")).toBe(true);

      const completed = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(completed.payload.resultKind).toBe("APPLIED");
    });
  });

  describe("R-TGT-10: TargetBinding sequence-start fixation (Issue #168 review [P2])", () => {
    it("UT-R-TGT-10-009: a targetBinding resolved once by resolveSkillOrder is never re-evaluated by applyEffectActionGroups — a later step referencing the same binding still targets (and skips) the original member after an earlier step defeats it, rather than redirecting to a unit that is only now the sole survivor", () => {
      const actor = unit("ACTOR", "ALLY");
      const primary = unit("PRIMARY", "ENEMY", { currentHp: 5 });
      const other = unit("OTHER", "ENEMY", { currentHp: 100 });
      const lethalHit = damageAction("ACT_LETHAL");
      const secondHit = damageAction("ACT_SECOND");
      const effectActions = new Map([
        [lethalHit.effectActionDefinitionId, lethalHit],
        [secondHit.effectActionDefinitionId, secondHit],
      ]);

      const bindingId = createTargetBindingId("TGT_MAIN");
      const enemySelector: TargetSelectorDefinition = {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      };
      const bindingTarget: TargetReference = { kind: "BINDING", targetBindingId: bindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [{ targetBindingId: bindingId, selector: enemySelector }],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: bindingTarget,
            actions: [{ effectActionDefinitionId: lethalHit.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: bindingTarget,
            actions: [{ effectActionDefinitionId: secondHit.effectActionDefinitionId }],
          },
        ],
      });

      // resolveSkillOrder resolves TGT_MAIN once, while both enemies are still alive:
      // PRIMARY and OTHER tie on every R-TGT-02 key (this file's `unit()` helper always
      // places units at the same position), so the stable sort keeps `allUnits`' input
      // order and TGT_MAIN binds to PRIMARY specifically (not OTHER).
      const plan = resolveSkillOrder(skill, actor, [actor, primary, other], effectActions);
      expect(plan.resolvedBindings.get(bindingId)?.units.map((u) => u.battleUnitId)).toEqual([
        primary.battleUnitId,
      ]);

      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);

      const result = applyEffectActionGroups(plan, [actor, primary, other], context);

      // Step 0 defeats PRIMARY (TGT_MAIN's fixed member). If TGT_MAIN were
      // re-evaluated before step 1 (a fixation regression), it would now resolve to
      // OTHER (the only surviving enemy) instead. It does not: step 1's
      // EffectActionStarting still names PRIMARY, and — because PRIMARY is already
      // defeated and this selector has no includeDefeated override — R-ACTN-01 #2
      // skips the application rather than silently redirecting it to OTHER.
      const actionStartingEvents = recorder
        .getEvents()
        .filter(
          (e): e is Extract<BattleDomainEvent, { eventType: "EffectActionStarting" }> =>
            e.eventType === "EffectActionStarting",
        );
      expect(actionStartingEvents[1]?.targetUnitIds).toEqual([primary.battleUnitId]);

      const actionCompletedEvents = recorder
        .getEvents()
        .filter(
          (e): e is Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }> =>
            e.eventType === "EffectActionCompleted",
        );
      expect(actionCompletedEvents[1]?.payload.resultKind).toBe("SKIPPED");

      const untouchedOther = result.units.find((u) => u.battleUnitId === other.battleUnitId)!;
      expect(untouchedOther.currentHp).toBe(100);
      // resolvedEffectCount counts both hits (step 0's APPLIED and step 1's SKIPPED are
      // both non-interrupted resolutions); the important assertions are the target
      // identity and resultKind checks above, and OTHER's untouched HP.
      expectCompleted(result, 2);
    });
  });

  describe("R-SKL-07: BRANCH / RANDOM_BRANCH / REPEAT (RES-003, Issue #217)", () => {
    it("UT-R-SKL-07-101: BRANCH resolves thenSteps when condition is true, never touching elseSteps", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const thenHit = damageAction("ACT_THEN");
      const elseHit = damageAction("ACT_ELSE");
      const effectActions = new Map([
        [thenHit.effectActionDefinitionId, thenHit],
        [elseHit.effectActionDefinitionId, elseHit],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [actionOn({ kind: "SELF" }, thenHit.effectActionDefinitionId)],
        elseSteps: [actionOn({ kind: "SELF" }, elseHit.effectActionDefinitionId)],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const kinds = recorder.getEvents().map((e) => e.eventType);
      expect(kinds).toEqual([
        "TurnStarted",
        "EffectStepStarting",
        "EffectStepStarting",
        "EffectActionStarting",
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageCalculated",
        "HitPointReduced",
        "DamageApplied",
        "EffectActionCompleted",
        "EffectStepCompleted",
        "EffectStepCompleted",
      ]);
      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === elseHit.effectActionDefinitionId,
          ),
      ).toBe(false);
      expectCompleted(result, 1);
    });

    it("UT-R-SKL-07-102: BRANCH resolves elseSteps when condition is false", () => {
      const actor = unit("ACTOR", "ALLY");
      const thenHit = damageAction("ACT_THEN");
      const elseHit = damageAction("ACT_ELSE");
      const effectActions = new Map([
        [thenHit.effectActionDefinitionId, thenHit],
        [elseHit.effectActionDefinitionId, elseHit],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "NOT", condition: { kind: "TRUE" } },
        thenSteps: [actionOn({ kind: "SELF" }, thenHit.effectActionDefinitionId)],
        elseSteps: [actionOn({ kind: "SELF" }, elseHit.effectActionDefinitionId)],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === thenHit.effectActionDefinitionId,
          ),
      ).toBe(false);
      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === elseHit.effectActionDefinitionId,
          ),
      ).toBe(true);
      expectCompleted(result, 1);
    });

    it("UT-R-SKL-07-103: nested BRANCH inside thenSteps resolves correctly", () => {
      const actor = unit("ACTOR", "ALLY");
      const innerHit = damageAction("ACT_INNER");
      const effectActions = new Map([[innerHit.effectActionDefinitionId, innerHit]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const outer: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [
          {
            kind: "BRANCH",
            condition: { kind: "TRUE" },
            thenSteps: [actionOn({ kind: "SELF" }, innerHit.effectActionDefinitionId)],
            elseSteps: [],
          },
        ],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, outer)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expectCompleted(result, 1);
      // outer BRANCH + inner BRANCH + the innermost ACTION step, each emit their own EffectStepStarting.
      expect(recorder.getEvents().filter((e) => e.eventType === "EffectStepStarting")).toHaveLength(
        3,
      );
    });

    it("UT-R-SKL-07-104: RANDOM_BRANCH WEIGHTED_ONE consumes exactly one random draw and resolves only the selected branch", () => {
      const actor = unit("ACTOR", "ALLY");
      const branchAHit = damageAction("ACT_BRANCH_A");
      const branchBHit = damageAction("ACT_BRANCH_B");
      const effectActions = new Map([
        [branchAHit.effectActionDefinitionId, branchAHit],
        [branchBHit.effectActionDefinitionId, branchBHit],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const random = new SequenceRandomSource([0.75]);
      const context = { ...contextFor(actor, effectActions, recorder, rootEventId), random };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "a",
            weight: 1,
            steps: [actionOn({ kind: "SELF" }, branchAHit.effectActionDefinitionId)],
          },
          {
            label: "b",
            weight: 1,
            steps: [actionOn({ kind: "SELF" }, branchBHit.effectActionDefinitionId)],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      random.assertFullyConsumed();
      const selected = recorder
        .getEvents()
        .find((e) => e.eventType === "RandomBranchSelected") as Extract<
        BattleDomainEvent,
        { eventType: "RandomBranchSelected" }
      >;
      expect(selected.payload).toEqual({
        stepIndex: 0,
        mode: "WEIGHTED_ONE",
        branchIndex: 1,
        label: "b",
      });
      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === branchAHit.effectActionDefinitionId,
          ),
      ).toBe(false);
      expectCompleted(result, 1);
    });

    it("UT-R-SKL-07-105: RANDOM_BRANCH WEIGHTED_ONE never selects a weight-0 branch", () => {
      const actor = unit("ACTOR", "ALLY");
      const onlyHit = damageAction("ACT_ONLY");
      const effectActions = new Map([[onlyHit.effectActionDefinitionId, onlyHit]]);
      const { recorder, rootEventId } = seedRecorder();
      const random = new SequenceRandomSource([0.999999]);
      const context = { ...contextFor(actor, effectActions, recorder, rootEventId), random };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          { label: "unreachable", weight: 0, steps: [] },
          {
            label: "only",
            weight: 1,
            steps: [actionOn({ kind: "SELF" }, onlyHit.effectActionDefinitionId)],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      applyEffectActionGroups(plan, [actor], context);

      const selected = recorder
        .getEvents()
        .find((e) => e.eventType === "RandomBranchSelected") as Extract<
        BattleDomainEvent,
        { eventType: "RandomBranchSelected" }
      >;
      expect(selected.payload.branchIndex).toBe(1);
    });

    it("UT-R-SKL-07-106: RANDOM_BRANCH INDEPENDENT resolves every branch whose independent probability roll succeeds, in Catalog order", () => {
      const actor = unit("ACTOR", "ALLY");
      const branchAHit = damageAction("ACT_BRANCH_A");
      const branchBHit = damageAction("ACT_BRANCH_B");
      const effectActions = new Map([
        [branchAHit.effectActionDefinitionId, branchAHit],
        [branchBHit.effectActionDefinitionId, branchBHit],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      // branch A: probability 0.5, roll 0.1 -> succeeds. branch B: probability 0.5, roll 0.9 -> fails is
      // avoided here; use 0.4 to also succeed, proving both can fire independently.
      const random = new SequenceRandomSource([0.1, 0.4]);
      const context = { ...contextFor(actor, effectActions, recorder, rootEventId), random };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [
          {
            label: "a",
            probability: 0.5,
            steps: [actionOn({ kind: "SELF" }, branchAHit.effectActionDefinitionId)],
          },
          {
            label: "b",
            probability: 0.5,
            steps: [actionOn({ kind: "SELF" }, branchBHit.effectActionDefinitionId)],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      random.assertFullyConsumed();
      const selectedEvents = recorder
        .getEvents()
        .filter((e) => e.eventType === "RandomBranchSelected");
      expect(selectedEvents.map((e) => e.payload.branchIndex)).toEqual([0, 1]);
      expectCompleted(result, 2);
    });

    it("UT-R-SKL-07-107: RANDOM_BRANCH INDEPENDENT with zero successful branches completes normally with no RandomBranchSelected events", () => {
      const actor = unit("ACTOR", "ALLY");
      const { recorder, rootEventId } = seedRecorder();
      const random = new SequenceRandomSource([0.9, 0.9]);
      const context = { ...contextFor(actor, new Map(), recorder, rootEventId), random };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [
          { label: "a", probability: 0.5, steps: [] },
          { label: "b", probability: 0.5, steps: [] },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      random.assertFullyConsumed();
      expect(recorder.getEvents().some((e) => e.eventType === "RandomBranchSelected")).toBe(false);
      expectCompleted(result, 0);
    });

    it("UT-R-SKL-07-108: RANDOM_BRANCH INDEPENDENT never rolls RNG for a probability-0 branch", () => {
      const actor = unit("ACTOR", "ALLY");
      const { recorder, rootEventId } = seedRecorder();
      const random = new SequenceRandomSource([0.1]);
      const context = { ...contextFor(actor, new Map(), recorder, rootEventId), random };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [
          { label: "unreachable", probability: 0, steps: [] },
          { label: "reachable", probability: 1, steps: [] },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [],
        resolvedBindings: new Map(),
      };

      applyEffectActionGroups(plan, [actor], context);

      random.assertFullyConsumed();
      const selected = recorder
        .getEvents()
        .find((e) => e.eventType === "RandomBranchSelected") as Extract<
        BattleDomainEvent,
        { eventType: "RandomBranchSelected" }
      >;
      expect(selected.payload.branchIndex).toBe(1);
    });

    it("UT-R-SKL-07-109: REPEAT resolves its body count times", () => {
      const actor = unit("ACTOR", "ALLY");
      const hit = damageAction("ACT_REPEAT_HIT");
      const effectActions = new Map([[hit.effectActionDefinitionId, hit]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const repeat: EffectStepDefinition = {
        kind: "REPEAT",
        count: 3,
        steps: [actionOn({ kind: "SELF" }, hit.effectActionDefinitionId)],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, repeat)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(
        recorder.getEvents().filter((e) => e.eventType === "EffectActionCompleted"),
      ).toHaveLength(3);
      expectCompleted(result, 3);
    });

    it("UT-R-SKL-07-110: REPEAT halts remaining iterations when the actor is defeated mid-iteration, contributing only the exact remainder of the currently-open ACTION application (Issue #217 design point D2)", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const selfHit = damageAction("ACT_SELF_HIT");
      const effectActions = new Map([[selfHit.effectActionDefinitionId, selfHit]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const repeat: EffectStepDefinition = {
        kind: "REPEAT",
        count: 3,
        steps: [actionOn({ kind: "SELF" }, selfHit.effectActionDefinitionId)],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, repeat)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      // The first iteration's self-hit is lethal; iterations 2 and 3 never begin.
      expect(
        recorder.getEvents().filter((e) => e.eventType === "EffectActionCompleted"),
      ).toHaveLength(1);
      expectInterrupted(result, 1, 0);
    });
  });

  describe("R-SKL-08: LAST_RESULT / LAST_ACTION_TARGETS / LAST_DAMAGED_TARGETS (RES-003, Issue #217)", () => {
    it("UT-R-SKL-08-009: a BRANCH condition referencing LAST_RESULT sees the immediately preceding ACTION step's confirmed result", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const attack = damageAction("ACT_ATTACK");
      const followUp = damageAction("ACT_FOLLOW_UP");
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
        [followUp.effectActionDefinitionId, followUp],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
        thenSteps: [actionOn({ kind: "SELF" }, followUp.effectActionDefinitionId)],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId),
          deferredStep(1, branch),
        ],
        targetUnitIds: [enemy.battleUnitId, actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === followUp.effectActionDefinitionId,
          ),
      ).toBe(true);
      expectCompleted(result, 2);
    });

    it("UT-R-SKL-08-010: LAST_ACTION_TARGETS/LAST_DAMAGED_TARGETS resolve to the preceding ACTION step's actual targets", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy1 = unit("ENEMY_1", "ENEMY");
      const enemy2 = unit("ENEMY_2", "ENEMY");
      const attack = damageAction("ACT_ATTACK");
      const markerId = createMarkerId("MARKER_FOLLOW_UP");
      const followUpMarker = markerAction("ACT_FOLLOW_UP_MARKER", markerId);
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
        [followUpMarker.effectActionDefinitionId, followUpMarker],
      ]);
      const bindingId = createTargetBindingId("TGT_ALL_ENEMIES");
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const followUpStep = actionOn(
        { kind: "LAST_DAMAGED_TARGETS" },
        followUpMarker.effectActionDefinitionId,
      );
      const plan: EffectSequencePlan = {
        steps: [
          {
            planKind: "ACTION_PLAN",
            stepIndex: 0,
            stepKind: "ACTION",
            conditionKind: "TRUE",
            satisfied: true,
            actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
            applications: [enemy1, enemy2].map((target) => ({
              targetBattleUnitId: target.battleUnitId,
              effectActionDefinitionId: attack.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetBattleUnitId: target.battleUnitId,
                  effectActionDefinitionId: attack.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            })),
          },
          deferredStep(1, followUpStep),
        ],
        targetUnitIds: [enemy1.battleUnitId, enemy2.battleUnitId],
        resolvedBindings: new Map([
          [bindingId, { units: [enemy1, enemy2], includeDefeated: false }],
        ]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy1, enemy2], context);

      const markerTargets = new Set(
        result.units
          .filter((u) => u.markerStates.some((m) => m.markerId === markerId))
          .map((u) => u.battleUnitId),
      );
      expect(markerTargets).toEqual(new Set([enemy1.battleUnitId, enemy2.battleUnitId]));
      // 2 DAMAGE hits (step 0, one per enemy) + 2 APPLY_MARKER applications (step 1, one per LAST_DAMAGED_TARGETS entry).
      expectCompleted(result, 4);
    });

    it("UT-R-SKL-08-011: an ACTION step whose binding resolves to zero targets still records a synthetic SKIPPED last-result visible to a following LAST_RESULT condition (Catalog preflight MISSING_PRECEDING_RESULT invariant)", () => {
      const actor = unit("ACTOR", "ALLY");
      const zeroTargetHit = damageAction("ACT_ZERO_TARGET");
      const followUp = damageAction("ACT_FOLLOW_UP");
      const effectActions = new Map([
        [zeroTargetHit.effectActionDefinitionId, zeroTargetHit],
        [followUp.effectActionDefinitionId, followUp],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "SKIPPED" },
        thenSteps: [actionOn({ kind: "SELF" }, followUp.effectActionDefinitionId)],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [
          {
            planKind: "ACTION_PLAN",
            stepIndex: 0,
            stepKind: "ACTION",
            conditionKind: "TRUE",
            satisfied: true,
            actions: [{ effectActionDefinitionId: zeroTargetHit.effectActionDefinitionId }],
            applications: [],
          },
          deferredStep(1, branch),
        ],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === followUp.effectActionDefinitionId,
          ),
      ).toBe(true);
      expectCompleted(result, 1);
    });

    it("UT-R-SKL-08-013 (PR #218 review [P2]): a zero-target ACTION step with multiple actions records the definition-order-last action as the synthetic SKIPPED last-result, not the first", () => {
      const actor = unit("ACTOR", "ALLY");
      const firstAction = damageAction("ACT_FIRST");
      const lastAction = damageAction("ACT_LAST");
      const followUp = damageAction("ACT_FOLLOW_UP");
      const effectActions = new Map([
        [firstAction.effectActionDefinitionId, firstAction],
        [lastAction.effectActionDefinitionId, lastAction],
        [followUp.effectActionDefinitionId, followUp],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      // A follow-up that only applies when the synthesized last-result's
      // effectActionDefinitionId is the definition-order-last action
      // (`ACT_LAST`), not the first (`ACT_FIRST`).
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: {
          kind: "LAST_RESULT",
          field: "effectActionDefinitionId",
          op: "EQ",
          value: lastAction.effectActionDefinitionId,
        },
        thenSteps: [actionOn({ kind: "SELF" }, followUp.effectActionDefinitionId)],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [
          {
            planKind: "ACTION_PLAN",
            stepIndex: 0,
            stepKind: "ACTION",
            conditionKind: "TRUE",
            satisfied: true,
            actions: [
              { effectActionDefinitionId: firstAction.effectActionDefinitionId },
              { effectActionDefinitionId: lastAction.effectActionDefinitionId },
            ],
            applications: [],
          },
          deferredStep(1, branch),
        ],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === followUp.effectActionDefinitionId,
          ),
      ).toBe(true);
      expectCompleted(result, 1);
    });

    it("UT-R-SKL-08-012: a LAST_RESULT condition with no preceding EffectAction result throws a Catalog-authoring error (defensive; Catalog preflight should already reject this Catalog)", () => {
      const actor = unit("ACTOR", "ALLY");
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, new Map(), recorder, rootEventId);
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
        thenSteps: [],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branch)],
        targetUnitIds: [],
        resolvedBindings: new Map(),
      };

      expect(() => applyEffectActionGroups(plan, [actor], context)).toThrow(DomainValidationError);
    });
  });

  describe("Interruption invariants (Issue #217 design points B/D2/D3)", () => {
    function killActorOnEvent(
      eventType: BattleDomainEvent["eventType"],
      actorId: BattleUnit["battleUnitId"],
    ): NonNullable<EffectActionGroupContext["onFactEventForPassiveChain"]> {
      return (event, units) => {
        if (event.eventType !== eventType) {
          return units;
        }
        return units.map((u) => (u.battleUnitId === actorId ? { ...u, currentHp: 0 } : u));
      };
    }

    it("UT-R-SKL-INT-001: BRANCH interrupted right after its own EffectStepStarting never enters thenSteps/elseSteps, and reports unresolvedEffectCount: 0", () => {
      const actor = unit("ACTOR", "ALLY");
      const hit = damageAction("ACT_HIT");
      const effectActions = new Map([[hit.effectActionDefinitionId, hit]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(
        actor,
        effectActions,
        recorder,
        rootEventId,
        killActorOnEvent("EffectStepStarting", actor.battleUnitId),
      );
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [actionOn({ kind: "SELF" }, hit.effectActionDefinitionId)],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(recorder.getEvents().some((e) => e.eventType === "EffectActionStarting")).toBe(false);
      expectInterrupted(result, 0, 0);
    });

    it("UT-R-SKL-INT-002: RANDOM_BRANCH (WEIGHTED_ONE) interrupted right after its own EffectStepStarting never consumes RNG or selects a branch", () => {
      const actor = unit("ACTOR", "ALLY");
      const { recorder, rootEventId } = seedRecorder();
      const random = new SequenceRandomSource([]);
      const context = {
        ...contextFor(
          actor,
          new Map(),
          recorder,
          rootEventId,
          killActorOnEvent("EffectStepStarting", actor.battleUnitId),
        ),
        random,
      };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [{ weight: 1, steps: [] }],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      random.assertFullyConsumed();
      expect(recorder.getEvents().some((e) => e.eventType === "RandomBranchSelected")).toBe(false);
      expectInterrupted(result, 0, 0);
    });

    it("UT-R-SKL-INT-003: RANDOM_BRANCH (WEIGHTED_ONE) interrupted right after RandomBranchSelected never enters the chosen branch's steps", () => {
      const actor = unit("ACTOR", "ALLY");
      const hit = damageAction("ACT_HIT");
      const effectActions = new Map([[hit.effectActionDefinitionId, hit]]);
      const { recorder, rootEventId } = seedRecorder();
      const random = new SequenceRandomSource([0]);
      const context = {
        ...contextFor(
          actor,
          effectActions,
          recorder,
          rootEventId,
          killActorOnEvent("RandomBranchSelected", actor.battleUnitId),
        ),
        random,
      };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          { weight: 1, steps: [actionOn({ kind: "SELF" }, hit.effectActionDefinitionId)] },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      random.assertFullyConsumed();
      expect(recorder.getEvents().some((e) => e.eventType === "EffectActionStarting")).toBe(false);
      expectInterrupted(result, 0, 0);
    });

    it("UT-R-SKL-INT-004: REPEAT interrupted right after its own EffectStepStarting runs zero iterations", () => {
      const actor = unit("ACTOR", "ALLY");
      const hit = damageAction("ACT_HIT");
      const effectActions = new Map([[hit.effectActionDefinitionId, hit]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(
        actor,
        effectActions,
        recorder,
        rootEventId,
        killActorOnEvent("EffectStepStarting", actor.battleUnitId),
      );
      const repeat: EffectStepDefinition = {
        kind: "REPEAT",
        count: 3,
        steps: [actionOn({ kind: "SELF" }, hit.effectActionDefinitionId)],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, repeat)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(recorder.getEvents().some((e) => e.eventType === "EffectActionStarting")).toBe(false);
      expectInterrupted(result, 0, 0);
    });

    it("UT-R-SKL-INT-005: a trailing sibling in the same raw step list is never entered once an earlier sibling interrupts (structure: nested, trailing sibling)", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const selfHit = damageAction("ACT_SELF_HIT");
      const neverRuns = damageAction("ACT_NEVER_RUNS");
      const effectActions = new Map([
        [selfHit.effectActionDefinitionId, selfHit],
        [neverRuns.effectActionDefinitionId, neverRuns],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const outer: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [
          actionOn({ kind: "SELF" }, selfHit.effectActionDefinitionId),
          actionOn({ kind: "SELF" }, neverRuns.effectActionDefinitionId),
        ],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, outer)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === neverRuns.effectActionDefinitionId,
          ),
      ).toBe(false);
      // resolvedEffectCount: 1 (the lethal self-hit, the sole ACTION step
      // inside thenSteps that actually opened). unresolvedEffectCount: 0 —
      // the trailing sibling ACTION step was never entered (Issue #217 D2/D3).
      expectInterrupted(result, 1, 0);
    });

    it("UT-R-SKL-INT-006: RANDOM_BRANCH (INDEPENDENT) actor defeated while resolving an earlier branch never rolls RNG for a later branch", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const selfHit = damageAction("ACT_SELF_HIT");
      const effectActions = new Map([[selfHit.effectActionDefinitionId, selfHit]]);
      const { recorder, rootEventId } = seedRecorder();
      // Only one value is preset: if branch B's probability roll were
      // (incorrectly) attempted, SequenceRandomSource would throw
      // "exhausted", failing this test loudly.
      const random = new SequenceRandomSource([0]);
      const context = { ...contextFor(actor, effectActions, recorder, rootEventId), random };
      const randomBranch: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [
          {
            label: "a",
            probability: 1,
            steps: [actionOn({ kind: "SELF" }, selfHit.effectActionDefinitionId)],
          },
          { label: "b", probability: 1, steps: [] },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranch)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      random.assertFullyConsumed();
      const selectedEvents = recorder
        .getEvents()
        .filter((e) => e.eventType === "RandomBranchSelected");
      expect(selectedEvents.map((e) => e.payload.branchIndex)).toEqual([0]);
      expectInterrupted(result, 1, 0);
    });

    it("UT-R-SKL-INT-007 (PR #218 review [P2], 2nd re-review): unresolvedEffectCount counts remaining hits for a multi-hit DAMAGE application, not remaining applications", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      // 3-hit self-DAMAGE: the first hit alone is lethal (attack 20 vs hp 5),
      // so hits 2 and 3 of this single application are interrupted before
      // they run. unresolvedEffectCount must be 2 (remaining hits), not 1
      // (as it would be if counted per-application).
      const tripleSelfHit = damageAction("ACT_TRIPLE_SELF_HIT", 3);
      const effectActions = new Map([[tripleSelfHit.effectActionDefinitionId, tripleSelfHit]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          {
            planKind: "ACTION_PLAN",
            stepIndex: 0,
            stepKind: "ACTION",
            conditionKind: "TRUE",
            satisfied: true,
            actions: [{ effectActionDefinitionId: tripleSelfHit.effectActionDefinitionId }],
            applications: [
              {
                targetBattleUnitId: actor.battleUnitId,
                effectActionDefinitionId: tripleSelfHit.effectActionDefinitionId,
                includeDefeated: false,
                hits: [1, 2, 3].map((hitIndex) => ({
                  targetBattleUnitId: actor.battleUnitId,
                  effectActionDefinitionId: tripleSelfHit.effectActionDefinitionId,
                  hitIndex,
                })),
              },
            ],
          },
        ],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expectInterrupted(result, 1, 2);
    });
  });

  describe("CAP_EFFECT_STEP_CONDITION（Issue #171 RES-004後半、PRレビュー[P1]）: 対象別条件は実行時の最新状態で評価する", () => {
    it("UT-R-SKL-06-022: a later step's TARGET_HAS_MARKER condition sees a marker an earlier step in the same EffectSequence just granted (not the state from before the sequence started)", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const markerId = createMarkerId("MARKER_TEST");
      const grantMarker = markerAction("ACT_GRANT_MARKER", markerId);
      const conditionalHit = damageAction("ACT_CONDITIONAL_HIT");
      const effectActions = new Map([
        [grantMarker.effectActionDefinitionId, grantMarker],
        [conditionalHit.effectActionDefinitionId, conditionalHit],
      ]);

      const firstBindingId = createTargetBindingId("TGT_FIRST");
      const allBindingId = createTargetBindingId("TGT_ALL");
      const enemySelector = (count: number | "ALL"): TargetSelectorDefinition => ({
        kind: "SELECT",
        side: "ENEMY",
        count,
        filters: [],
        order: ["DEFAULT"],
        includeDefeated: false,
      });
      const allTarget: TargetReference = { kind: "BINDING", targetBindingId: allBindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: firstBindingId, selector: enemySelector(1) },
          { targetBindingId: allBindingId, selector: enemySelector("ALL") },
        ],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: firstBindingId },
            actions: [{ effectActionDefinitionId: grantMarker.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            condition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
            target: allTarget,
            actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
          },
        ],
      });

      // R-TGT-02（`unit()`は全員同じ位置に置くため、この選定はallUnitsの入力順で
      // タイブレークする — `UT-R-TGT-10-009`と同じ前提）: TGT_FIRSTはenemyAに
      // 束縛される。TARGET_HAS_MARKERを含むstep 2のconditionは自身のtarget
      // （TGT_ALL）を参照するため、`isEagerActionStep`によりDeferredへ回り、
      // step 1がenemyAへMarkerを付与し終えてから（実行が逐次進んだ後に）JITで
      // 評価される。
      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);

      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      const completed = recorder
        .getEvents()
        .find(
          (e) =>
            e.eventType === "EffectActionCompleted" &&
            e.payload.effectActionDefinitionId === conditionalHit.effectActionDefinitionId,
        ) as Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }>;
      expect(completed.payload.resultKind).toBe("APPLIED");
      expect(completed.payload.targetUnitIds).toEqual([enemyA.battleUnitId]);
    });

    it("UT-R-SKL-06-023: a self-referencing TARGET_HAS_MARKER condition is (re-)evaluated after EffectStepStarting's own PS/Memory chain has mutated marker state, not before it is emitted", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const markerId = createMarkerId("MARKER_TEST");
      const conditionalHit = damageAction("ACT_CONDITIONAL_HIT");
      const effectActions = new Map([[conditionalHit.effectActionDefinitionId, conditionalHit]]);

      const allBindingId = createTargetBindingId("TGT_ALL");
      const allTarget: TargetReference = { kind: "BINDING", targetBindingId: allBindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: allBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
            target: allTarget,
            actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      // Simulates a PS reacting to this step's own `EffectStepStarting` (TIMING)
      // by granting enemyA the marker — neither enemy has it before this event.
      const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
        if (event.eventType !== "EffectStepStarting") {
          return units;
        }
        return units.map((u) =>
          u.battleUnitId === enemyA.battleUnitId
            ? {
                ...u,
                markerStates: [
                  {
                    markerInstanceId: createMarkerInstanceId("MARKER_INSTANCE_1"),
                    markerId,
                    sourceId: actor.battleUnitId,
                    targetId: u.battleUnitId,
                    stackCount: 1,
                    stackMax: null,
                    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
                  },
                ],
              }
            : u,
        );
      });

      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      const completed = recorder
        .getEvents()
        .find(
          (e) =>
            e.eventType === "EffectActionCompleted" &&
            e.payload.effectActionDefinitionId === conditionalHit.effectActionDefinitionId,
        ) as Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }>;
      expect(completed.payload.resultKind).toBe("APPLIED");
      expect(completed.payload.targetUnitIds).toEqual([enemyA.battleUnitId]);
    });

    it("UT-R-SKL-06-024（PRレビュー[P2]再指摘）: a self-referencing condition is never evaluated (and its actions never started) once EffectStepStarting's own chain has defeated the actor — INTERRUPTED with unresolvedEffectCount: 0", () => {
      const actor = unit("ACTOR", "ALLY");
      const markerId = createMarkerId("MARKER_TEST");
      // Both enemies already hold the marker before the step even starts, so
      // the self-referencing condition would match both if it were (wrongly)
      // evaluated — proving the actor-defeated short-circuit, not an
      // otherwise-empty match, is why no application happens.
      const markerState = (owner: BattleUnit): MarkerState => ({
        markerInstanceId: createMarkerInstanceId("MARKER_INSTANCE_1"),
        markerId,
        sourceId: actor.battleUnitId,
        targetId: owner.battleUnitId,
        stackCount: 1,
        stackMax: null,
        duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      });
      const enemyABase = unit("ENEMY_A", "ENEMY");
      const enemyA = { ...enemyABase, markerStates: [markerState(enemyABase)] };
      const enemyBBase = unit("ENEMY_B", "ENEMY");
      const enemyB = { ...enemyBBase, markerStates: [markerState(enemyBBase)] };
      const conditionalHit = damageAction("ACT_CONDITIONAL_HIT");
      const effectActions = new Map([[conditionalHit.effectActionDefinitionId, conditionalHit]]);

      const allBindingId = createTargetBindingId("TGT_ALL");
      const allTarget: TargetReference = { kind: "BINDING", targetBindingId: allBindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: allBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
            target: allTarget,
            actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      // Simulates a PS reacting to this step's own `EffectStepStarting` (TIMING)
      // by defeating the actor before its condition/applications are ever built.
      const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
        if (event.eventType !== "EffectStepStarting") {
          return units;
        }
        return units.map((u) =>
          u.battleUnitId === actor.battleUnitId ? { ...u, currentHp: 0 } : u,
        );
      });

      const result = applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      expectInterrupted(result, 0, 0);
      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === conditionalHit.effectActionDefinitionId,
          ),
      ).toBe(false);
    });
  });

  describe("CAP_EFFECT_STEP_SET_CONDITION（Issue #227 RES-004集合条件）: TARGET_SET_COUNTは対象集合の最新状態を反映する", () => {
    it("UT-R-SKL-06-034: a BRANCH's TARGET_SET_COUNT (EXISTS: op GTE, value 1) takes elseSteps once a preceding step's DAMAGE has defeated the only member of the referenced set", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY", { currentHp: 1 });
      const kill = damageAction("ACT_KILL");
      const thenMarkerId = createMarkerId("MARKER_THEN");
      const elseMarkerId = createMarkerId("MARKER_ELSE");
      const thenAction = markerAction("ACT_THEN", thenMarkerId);
      const elseAction = markerAction("ACT_ELSE", elseMarkerId);
      const effectActions = new Map([
        [kill.effectActionDefinitionId, kill],
        [thenAction.effectActionDefinitionId, thenAction],
        [elseAction.effectActionDefinitionId, elseAction],
      ]);

      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyTarget: TargetReference = { kind: "BINDING", targetBindingId: enemyBindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          actionOn(enemyTarget, kill.effectActionDefinitionId),
          {
            kind: "BRANCH",
            condition: { kind: "TARGET_SET_COUNT", target: enemyTarget, op: "GTE", value: 1 },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);

      applyEffectActionGroups(plan, [actor, enemyA], context);

      const completedActionIds = recorder
        .getEvents()
        .filter((e) => e.eventType === "EffectActionCompleted")
        .map((e) => e.payload.effectActionDefinitionId);
      expect(completedActionIds).toContain(elseAction.effectActionDefinitionId);
      expect(completedActionIds).not.toContain(thenAction.effectActionDefinitionId);
    });

    it("UT-R-SKL-06-035: a BRANCH's TARGET_SET_COUNT (EXISTS: op GTE, value 1) takes thenSteps once a survivor remains in the referenced set", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY", { currentHp: 1 });
      const enemyB = unit("ENEMY_B", "ENEMY", { currentHp: 100 });
      const kill = damageAction("ACT_KILL");
      const thenMarkerId = createMarkerId("MARKER_THEN");
      const elseMarkerId = createMarkerId("MARKER_ELSE");
      const thenAction = markerAction("ACT_THEN", thenMarkerId);
      const elseAction = markerAction("ACT_ELSE", elseMarkerId);
      const effectActions = new Map([
        [kill.effectActionDefinitionId, kill],
        [thenAction.effectActionDefinitionId, thenAction],
        [elseAction.effectActionDefinitionId, elseAction],
      ]);

      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyTarget: TargetReference = { kind: "BINDING", targetBindingId: enemyBindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          actionOn(enemyTarget, kill.effectActionDefinitionId),
          {
            kind: "BRANCH",
            condition: { kind: "TARGET_SET_COUNT", target: enemyTarget, op: "GTE", value: 1 },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);

      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      const completedActionIds = recorder
        .getEvents()
        .filter((e) => e.eventType === "EffectActionCompleted")
        .map((e) => e.payload.effectActionDefinitionId);
      expect(completedActionIds).toContain(thenAction.effectActionDefinitionId);
      expect(completedActionIds).not.toContain(elseAction.effectActionDefinitionId);
    });

    it("UT-R-SKL-06-036: a BRANCH's TARGET_SET_COUNT COUNT threshold (op GTE, value 2) is boundary-exact against the number of survivors", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY", { currentHp: 1 });
      const enemyB = unit("ENEMY_B", "ENEMY", { currentHp: 100 });
      const enemyC = unit("ENEMY_C", "ENEMY", { currentHp: 100 });
      const kill = damageAction("ACT_KILL");
      const thenMarkerId = createMarkerId("MARKER_THEN");
      const elseMarkerId = createMarkerId("MARKER_ELSE");
      const thenAction = markerAction("ACT_THEN", thenMarkerId);
      const elseAction = markerAction("ACT_ELSE", elseMarkerId);
      const effectActions = new Map([
        [kill.effectActionDefinitionId, kill],
        [thenAction.effectActionDefinitionId, thenAction],
        [elseAction.effectActionDefinitionId, elseAction],
      ]);

      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyTarget: TargetReference = { kind: "BINDING", targetBindingId: enemyBindingId };
      // Only enemyA (currentHp: 1) dies from ACT_KILL; enemyB/enemyC (currentHp: 100)
      // survive, leaving exactly 2 alive members in TGT_ENEMY — the GTE 2 boundary.
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          actionOn(enemyTarget, kill.effectActionDefinitionId),
          {
            kind: "BRANCH",
            condition: { kind: "TARGET_SET_COUNT", target: enemyTarget, op: "GTE", value: 2 },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB, enemyC], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);

      applyEffectActionGroups(plan, [actor, enemyA, enemyB, enemyC], context);

      const completedActionIds = recorder
        .getEvents()
        .filter((e) => e.eventType === "EffectActionCompleted")
        .map((e) => e.payload.effectActionDefinitionId);
      expect(completedActionIds).toContain(thenAction.effectActionDefinitionId);
      expect(completedActionIds).not.toContain(elseAction.effectActionDefinitionId);
    });

    it("UT-R-SKL-06-037: an ACTION step's own (non-self-referencing) TARGET_SET_COUNT condition skips the whole step, not just individual targets, once the referenced set is empty", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY", { currentHp: 1 });
      const kill = damageAction("ACT_KILL");
      const conditionalHit = damageAction("ACT_CONDITIONAL_HIT");
      const effectActions = new Map([
        [kill.effectActionDefinitionId, kill],
        [conditionalHit.effectActionDefinitionId, conditionalHit],
      ]);

      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyTarget: TargetReference = { kind: "BINDING", targetBindingId: enemyBindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          actionOn(enemyTarget, kill.effectActionDefinitionId),
          {
            kind: "ACTION",
            condition: { kind: "TARGET_SET_COUNT", target: enemyTarget, op: "GTE", value: 1 },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);

      applyEffectActionGroups(plan, [actor, enemyA], context);

      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === conditionalHit.effectActionDefinitionId,
          ),
      ).toBe(false);
    });

    it("UT-R-SKL-06-038: a BRANCH's TARGET_SET_COUNT sees a marker a PS-style chain granted in reaction to a preceding step's EffectStepStarting, not the state from before that chain ran", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const noop = statModAction("ACT_NOOP");
      const thenAction = markerAction("ACT_THEN", createMarkerId("MARKER_THEN"));
      const elseAction = markerAction("ACT_ELSE", createMarkerId("MARKER_ELSE"));
      const effectActions = new Map([
        [noop.effectActionDefinitionId, noop],
        [thenAction.effectActionDefinitionId, thenAction],
        [elseAction.effectActionDefinitionId, elseAction],
      ]);

      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyTarget: TargetReference = { kind: "BINDING", targetBindingId: enemyBindingId };
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          {
            targetBindingId: enemyBindingId,
            selector: {
              kind: "SELECT",
              side: "ENEMY",
              count: "ALL",
              filters: [],
              order: ["DEFAULT"],
              includeDefeated: false,
            },
          },
        ],
        steps: [
          actionOn({ kind: "SELF" }, noop.effectActionDefinitionId),
          {
            kind: "BRANCH",
            condition: {
              kind: "TARGET_SET_COUNT",
              target: enemyTarget,
              op: "GTE",
              value: 1,
            },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      // Simulates a PS reacting to step 1's own `EffectStepStarting` (TIMING) by
      // defeating enemyA — before this chain runs, TGT_ENEMY resolves 1 alive
      // member (`GTE 1` would be true); the BRANCH must see the post-chain state.
      const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
        if (event.eventType !== "EffectStepStarting" || event.payload.stepIndex !== 0) {
          return units;
        }
        return units.map((u) =>
          u.battleUnitId === enemyA.battleUnitId ? { ...u, currentHp: 0 } : u,
        );
      });

      applyEffectActionGroups(plan, [actor, enemyA], context);

      const completedActionIds = recorder
        .getEvents()
        .filter((e) => e.eventType === "EffectActionCompleted")
        .map((e) => e.payload.effectActionDefinitionId);
      expect(completedActionIds).toContain(elseAction.effectActionDefinitionId);
      expect(completedActionIds).not.toContain(thenAction.effectActionDefinitionId);
    });
  });
});
