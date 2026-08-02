import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  resolveEffectSequencePlan,
  type EffectActionGroupContext,
  type EffectActionGroupsResult,
} from "./effect-action-group-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import { createHitPoint } from "../model/resource-gauge.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { shieldPoolsOf } from "../combat/shield-policy.js";
import { subUnitDurabilityTotal } from "../combat/sub-unit-policy.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import { resolveSkillOrder, type EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createActionId,
  createEffectInstanceId,
  createMarkerInstanceId,
} from "../../shared/event-ids.js";
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
import type { DamageResultRegistry } from "../skill/formula-evaluator.js";

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
      stacking: { mode: "STACKABLE", max: null },
      duration: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

function statusAction(
  id: string,
  duration: DurationDefinition = {
    timeLimit: { unit: "SKILL_USE", count: 3 },
    dispellable: true,
    linkedEffectGroupId: null,
  },
): EffectActionDefinition {
  return {
    kind: "APPLY_STATUS",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      status: "STEALTH",
      duration,
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
  targetCondition: ConditionDefinition = { kind: "TRUE" },
): Extract<EffectStepDefinition, { kind: "ACTION" }> {
  return {
    kind: "ACTION",
    stepCondition: { kind: "TRUE" },
    targetCondition,
    target,
    actions: [{ effectActionDefinitionId }],
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
      stealthConsumptions: [],
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
      "DamageWillBeApplied",
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
      stealthConsumptions: [],
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
      "DamageWillBeApplied",
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
      stealthConsumptions: [],
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
      "DamageWillBeApplied",
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
      stealthConsumptions: [],
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
      stealthConsumptions: [],
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
      stealthConsumptions: [],
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
      stealthConsumptions: [],
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
      stealthConsumptions: [],
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
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, statMod.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(observedEventTypes).toContain("EffectApplied");
  });

  it("UT-R-EFF-01-044 (TGT-004フェーズ3、Issue #167、R-ACTN-03、real lifecycle wiring): an APPLY_STATUS ACTION step grants a statusKind-bearing AppliedEffect through the real Catalog -> EffectSequence -> AppliedEffect -> event pipeline, without touching CombatStats", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status = statusAction("ACT_STEALTH");
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
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
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);

    const grantedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(grantedTarget.appliedEffects).toHaveLength(1);
    expect(grantedTarget.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: status.effectActionDefinitionId,
      sourceId: actor.battleUnitId,
      targetId: enemy.battleUnitId,
      duplicate: true,
      magnitude: 0,
      statusKind: "STEALTH",
      appliedTurnNumber: 1,
    });
    expect(grantedTarget.appliedEffects[0]!.duration.timeLimitRemaining).toBe(3);

    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplied" }
    >;
    expect(applied.payload).toMatchObject({
      effectInstanceId: grantedTarget.appliedEffects[0]!.effectInstanceId,
      statusKind: "STEALTH",
      durationUnit: "SKILL_USE",
      initialRemaining: 3,
    });

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
    expect(completed.parentEventId).toBe(applied.eventId);
  });

  it("UT-R-EFF-01-045 (TGT-004フェーズ3、Issue #167): an APPLY_STATUS ACTION step against an already-defeated target grants no AppliedEffect and completes as SKIPPED", () => {
    const actor = unit("ACTOR", "ALLY");
    const defeated = unit("DEFEATED", "ENEMY", { currentHp: 0 });
    const status = statusAction("ACT_STEALTH");
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, defeated.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [defeated.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, defeated], context);

    const target = result.units.find((u) => u.battleUnitId === defeated.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(0);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(false);
    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("SKIPPED");
  });

  it("UT-R-EFF-01-046 (TGT-004フェーズ3、Issue #167): an APPLY_STATUS payload with probability/appliesTo/damageThreshold/damageAmplificationOnBreak (R-STS-01〜04 scope, not yet implemented) throws a clear error instead of silently granting unconditionally", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        probability: 0.5,
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    expect(() => applyEffectActionGroups(plan, [actor, enemy], context)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-EFF-01-051 (Issue #180, M7-003, R-STS-02): a STUN APPLY_STATUS payload with NO extra fields (e.g. production ACT_CHIZURU_DOMESTIC_AS1_STUN's exact shape: just status+duration) grants the status", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN_NO_EXTRA_FIELDS"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({ statusKind: "STUN" });
  });

  it("UT-R-HIT-03-010 (R-HIT-03/R-STS-04, Issue #183, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(BLIND) ACTION step grants a statusKind BLIND AppliedEffect carrying statusDetails.probability through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const status: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_BLIND"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "BLIND",
        probability: 0.55,
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[status.effectActionDefinitionId, status]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, status.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "BLIND",
      statusDetails: { probability: 0.55 },
    });
    expect(target.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
  });

  it("UT-R-DMG-02-010 (R-DMG-02, Issue #183, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(DAMAGE_IMMUNITY) ACTION step grants a statusKind DAMAGE_IMMUNITY AppliedEffect carrying statusDetails.damageThreshold through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const immunity: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_IMMUNITY"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "DAMAGE_IMMUNITY",
        damageThreshold: {
          op: "GT",
          formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
        },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[immunity.effectActionDefinitionId, immunity]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, immunity.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "DAMAGE_IMMUNITY",
      statusDetails: {
        damageThreshold: {
          op: "GT",
          formula: { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.35 },
        },
      },
    });
  });

  it("UT-R-STS-03-004 (R-STS-03, Issue #183, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(FREEZE) ACTION step grants a statusKind FREEZE AppliedEffect carrying statusDetails.damageAmplificationOnBreak through the real Catalog -> EffectSequence -> AppliedEffect pipeline, without cancelling a pending charge", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY", {
      charge: { skill: {}, startedActionId: {} } as unknown as NonNullable<BattleUnit["charge"]>,
    });
    const freeze: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "FREEZE",
        damageAmplificationOnBreak: 1.5,
        duration: {
          timeLimit: { unit: "ACTION", count: 3 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[freeze.effectActionDefinitionId, freeze]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, freeze.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "FREEZE",
      statusDetails: { damageAmplificationOnBreak: 1.5 },
    });
    expect(target.charge).toBeDefined();
    expect(recorder.getEvents().some((e) => e.eventType === "ChargeCancelled")).toBe(false);
  });

  it("UT-R-BON-ATTACK-DMG-001 (ON_ATTACK_BONUS_DAMAGE_BUFF, Issue #183, mirrors SKL_ELENA_MOODMAKER_EX): an APPLY_ATTACK_DAMAGE_BONUS ACTION step evaluates its formula once at grant time (STAT_RATIO(TARGET, ATTACK, 0.15)) and stores the result as magnitude on an isAttackDamageBonus AppliedEffect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY", {
      combatStats: { ...unit("X", "ENEMY").combatStats, attack: 40 },
    });
    const bonus: EffectActionDefinition = {
      kind: "APPLY_ATTACK_DAMAGE_BONUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATTACK_DAMAGE_BONUS"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        formula: { kind: "STAT_RATIO", source: { kind: "TARGET" }, stat: "ATTACK", ratio: 0.15 },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[bonus.effectActionDefinitionId, bonus]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, bonus.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      isAttackDamageBonus: true,
      magnitude: 6, // 40 attack * 0.15
    });
  });

  it("UT-R-STS-03-014 (レビュー指摘[P2], Issue #183, full stack): a DAMAGE ACTION step against a frozen target wired with a linked-group sibling cascades the sibling away through the real effect-action-group-resolver.ts -> damage-application-service.ts -> removeFreezeEffect injection", () => {
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 30 },
    });
    const statMod = statModAction("ACT_LINK");
    const freezeEffectId = createEffectInstanceId("freeze-1");
    const siblingEffectId = createEffectInstanceId("sibling-1");
    // `unit()`'s baseline attack is 20; simulate the sibling's +20% ATTACK
    // already contributing (as `grantEffect`/`recalculateCombatStats` would
    // have left it: 20 * 1.2 = 24) so its cascade removal produces a
    // detectable `before !== after` change.
    const enemy = unit("ENEMY", "ENEMY", {
      combatStats: { ...unit("E", "ENEMY").combatStats, defense: 10, attack: 24 },
      appliedEffects: [
        {
          effectInstanceId: freezeEffectId,
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
          kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
          duplicate: true,
          sourceId: createBattleUnitId("ACTOR"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "FREEZE",
          statusDetails: { damageAmplificationOnBreak: 0.5 },
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
        {
          effectInstanceId: siblingEffectId,
          effectActionDefinitionId: statMod.effectActionDefinitionId,
          kindKey: effectKindKeyFromDefinitionId(statMod.effectActionDefinitionId),
          duplicate: true,
          sourceId: createBattleUnitId("ENEMY"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0.2,
          categories: ["BUFF"],
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const dmg = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [dmg.effectActionDefinitionId, dmg],
      [statMod.effectActionDefinitionId, statMod],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, dmg.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const updatedEnemy = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(updatedEnemy.appliedEffects).toHaveLength(0);
    // The linked stat mod's +20% ATTACK is gone once cascaded away (back to
    // the 20 baseline).
    expect(updatedEnemy.combatStats.attack).toBe(20);

    const events = recorder.getEvents();
    const cascadeExpired = events.find(
      (ev) => ev.eventType === "EffectExpired" && ev.payload.effectInstanceId === siblingEffectId,
    );
    const freezeRemoved = events.find((ev) => ev.eventType === "FreezeRemoved");
    const combatStatChanged = events.find((ev) => ev.eventType === "CombatStatChanged");
    expect(cascadeExpired).toBeDefined();
    expect(cascadeExpired!.payload).toMatchObject({
      reason: "LINKED_GROUP_CASCADE",
      cascaded: true,
    });
    expect(freezeRemoved).toBeDefined();
    // Base damage 30 - 10 = 20, amplified by the freeze's +50% = 30.
    expect(freezeRemoved!.payload).toMatchObject({
      effectInstanceId: freezeEffectId,
      triggeringDamage: 30,
    });
    expect(combatStatChanged).toBeDefined();
    expect(events.indexOf(cascadeExpired!)).toBeLessThan(events.indexOf(freezeRemoved!));
  });

  it("UT-R-STS-03-016 (レビュー再指摘[P2], Issue #183, full stack): the cascaded sibling's EffectExpired reaches onFactEventForPassiveChain before FreezeRemoved is recorded at all, through the real removeFreezeEffect injection", () => {
    const actor = unit("ACTOR", "ALLY", {
      combatStats: { ...unit("A", "ALLY").combatStats, attack: 30 },
    });
    const statMod = statModAction("ACT_LINK");
    const freezeEffectId = createEffectInstanceId("freeze-1");
    const siblingEffectId = createEffectInstanceId("sibling-1");
    const enemy = unit("ENEMY", "ENEMY", {
      combatStats: { ...unit("E", "ENEMY").combatStats, defense: 10, attack: 24 },
      appliedEffects: [
        {
          effectInstanceId: freezeEffectId,
          effectActionDefinitionId: createEffectActionDefinitionId("ACT_FREEZE"),
          kindKey: effectKindKeyFromDefinitionId(createEffectActionDefinitionId("ACT_FREEZE")),
          duplicate: true,
          sourceId: createBattleUnitId("ACTOR"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "FREEZE",
          statusDetails: { damageAmplificationOnBreak: 0.5 },
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
        {
          effectInstanceId: siblingEffectId,
          effectActionDefinitionId: statMod.effectActionDefinitionId,
          kindKey: effectKindKeyFromDefinitionId(statMod.effectActionDefinitionId),
          duplicate: true,
          sourceId: createBattleUnitId("ENEMY"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0.2,
          categories: ["BUFF"],
          duration: {
            definition: { dispellable: true, linkedEffectGroupId: "GROUP_A" },
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const dmg = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [dmg.effectActionDefinitionId, dmg],
      [statMod.effectActionDefinitionId, statMod],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    // Observer simulating a PS reacting to each notified event: records
    // whether FreezeRemoved is already present in the recorder at that
    // moment, to prove the cascade's EffectExpired is resolved strictly
    // before FreezeRemoved is even recorded (not just before HP applies).
    const observations: { eventType: string; freezeRemovedAlreadyRecorded: boolean }[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observations.push({
        eventType: event.eventType,
        freezeRemovedAlreadyRecorded: recorder
          .getEvents()
          .some((ev) => ev.eventType === "FreezeRemoved" && ev.eventId !== event.eventId),
      });
      return units;
    });
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, dmg.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    const cascadeExpiredObservation = observations.find((o) => o.eventType === "EffectExpired");
    expect(cascadeExpiredObservation).toBeDefined();
    expect(cascadeExpiredObservation!.freezeRemovedAlreadyRecorded).toBe(false);
    const freezeRemovedObservation = observations.find((o) => o.eventType === "FreezeRemoved");
    expect(freezeRemovedObservation).toBeDefined();
  });

  it("UT-R-HIT-02-011 (R-HIT-02, Issue #183, CAP_HIT_COUNT_EVASION): an APPLY_STATUS(EVASION) ACTION step grants a statusKind EVASION AppliedEffect carrying statusDetails.probability/appliesTo through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const evasion: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_EVASION"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "EVASION",
        probability: 0.6,
        appliesTo: { incomingActionKinds: ["DAMAGE"] },
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[evasion.effectActionDefinitionId, evasion]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, evasion.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "EVASION",
      statusDetails: {
        probability: 0.6,
        appliesTo: { incomingActionKinds: ["DAMAGE"] },
      },
    });
  });

  it("UT-R-HIT-04-009 (R-HIT-04, M7-018/Issue #272, CAP_HIT_COUNT_EVASION): an APPLY_STATUS(HIT_EVASION) ACTION step shaped like ACT_FLUTE_VAMPIRE_PS2_EVASION grants a statusKind HIT_EVASION AppliedEffect with its INCOMING_HIT consumption through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const hitEvasion: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_HIT_EVASION"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "HIT_EVASION",
        probability: 1,
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[hitEvasion.effectActionDefinitionId, hitEvasion]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, hitEvasion.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "HIT_EVASION",
      statusDetails: { probability: 1 },
      duration: { consumptionRemaining: 1 },
    });
  });

  it("UT-R-HIT-05-007 (R-HIT-05, M7-018/Issue #272, CAP_STATUS_EFFECT_KIND): an APPLY_STATUS(GUARANTEED_HIT) ACTION step shaped like ACT_LAYLA_ENTREPRENEUR_PS1_GUARANTEED_HIT grants a statusKind GUARANTEED_HIT AppliedEffect with its SKILL_USE time limit through the real Catalog -> EffectSequence -> AppliedEffect pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const guaranteedHit: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_GUARANTEED_HIT"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "GUARANTEED_HIT",
        probability: 1,
        duration: {
          timeLimit: { unit: "SKILL_USE", count: 4 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[guaranteedHit.effectActionDefinitionId, guaranteedHit]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, guaranteedHit.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "GUARANTEED_HIT",
      duration: { timeLimitRemaining: 4 },
    });
  });

  it("UT-R-HIT-05-008 (R-HIT-05, M7-018/Issue #272): an APPLY_STATUS(GUARANTEED_HIT) carrying incoming-side fields is rejected instead of being granted without effect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const guaranteedHit: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_GUARANTEED_HIT"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "GUARANTEED_HIT",
        appliesTo: { incomingActionKinds: ["DAMAGE"] },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    };
    const effectActions = new Map([[guaranteedHit.effectActionDefinitionId, guaranteedHit]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, guaranteedHit.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    expect(() => applyEffectActionGroups(plan, [actor, enemy], context)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-CRT-03-010 (R-CRT-03, DMG-003A/Issue #295, CAP_CRITICAL_CONTROL): an APPLY_STATUS(CRITICAL_GUARANTEE) ACTION step shaped like ACT_MIKOTO_SURVIVOR_EX_CRIT_GUARANTEE grants a statusKind CRITICAL_GUARANTEE AppliedEffect with its ACTION time limit", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const criticalGuarantee: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_CRIT_GUARANTEE"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "CRITICAL_GUARANTEE",
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([
      [criticalGuarantee.effectActionDefinitionId, criticalGuarantee],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, criticalGuarantee.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "CRITICAL_GUARANTEE",
      duration: { timeLimitRemaining: 2 },
    });
  });

  it("UT-R-CRT-03-011 (R-CRT-03, DMG-003A/Issue #295): an APPLY_STATUS(CRITICAL_PREVENTION) ACTION step shaped like ACT_TARISA_TROUBLEMAKER_AS1_CRIT_PREVENTION grants a statusKind CRITICAL_PREVENTION AppliedEffect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const criticalPrevention: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_CRIT_PREVENTION"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "CRITICAL_PREVENTION",
        probability: 1,
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([
      [criticalPrevention.effectActionDefinitionId, criticalPrevention],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, criticalPrevention.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({
      statusKind: "CRITICAL_PREVENTION",
      duration: { timeLimitRemaining: 1 },
    });
  });

  it("UT-R-CRT-03-012 (R-CRT-03 negative, DMG-003A/Issue #295): a critical status carrying incoming-side fields or a probability below 1 is rejected instead of being granted without effect", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const unsupportedPayloads = [
      {
        status: "CRITICAL_GUARANTEE" as const,
        appliesTo: { incomingActionKinds: ["DAMAGE" as const] },
      },
      {
        status: "CRITICAL_PREVENTION" as const,
        damageThreshold: { op: "GTE" as const, formula: { kind: "CONSTANT" as const, value: 10 } },
      },
      { status: "CRITICAL_PREVENTION" as const, damageAmplificationOnBreak: 0.5 },
      { status: "CRITICAL_GUARANTEE" as const, probability: 0.5 },
    ];

    for (const [index, extra] of unsupportedPayloads.entries()) {
      const definition: EffectActionDefinition = {
        kind: "APPLY_STATUS",
        effectActionDefinitionId: createEffectActionDefinitionId(`ACT_CRIT_UNSUPPORTED_${index}`),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: { ...extra, duration: { dispellable: true, linkedEffectGroupId: null } },
      };
      const effectActions = new Map([[definition.effectActionDefinitionId, definition]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, enemy.battleUnitId, definition.effectActionDefinitionId)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: new Map(),
      };

      expect(() => applyEffectActionGroups(plan, [actor, enemy], context)).toThrow(
        DomainValidationError,
      );
    }
  });

  it("UT-R-HIT-03-008 (R-HIT-03/R-STS-04, Issue #183): an actor whose own BLIND effect rolls MISS skips the entire EffectSequence — no ACTION step resolves, BlindnessCheckResolved and SkillMissed are recorded instead", () => {
    const blindEffectId = createEffectInstanceId("blind-1");
    const blindDefId = createEffectActionDefinitionId("ACT_BLIND");
    const actor = unit("ACTOR", "ALLY", {
      appliedEffects: [
        {
          effectInstanceId: blindEffectId,
          effectActionDefinitionId: blindDefId,
          kindKey: effectKindKeyFromDefinitionId(blindDefId),
          duplicate: true,
          sourceId: createBattleUnitId("SOURCE"),
          targetId: createBattleUnitId("ACTOR"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "BLIND",
          statusDetails: { probability: 0.5 },
          duration: {
            definition: {
              timeLimit: { unit: "ACTION", count: 2 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            timeLimitRemaining: 2,
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const enemy = unit("ENEMY", "ENEMY");
    const statMod = statModAction("ACT_ATK_UP");
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context: EffectActionGroupContext = {
      ...contextFor(actor, effectActions, recorder, rootEventId),
      random: new SequenceRandomSource([0.1]),
    };
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
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

    expect(emitted).toEqual(["BlindnessCheckResolved", "SkillMissed"]);
    expect(result.outcome).toEqual({ status: "COMPLETED", resolvedEffectCount: 0 });
    expect(
      result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!.appliedEffects,
    ).toHaveLength(0);

    const blindnessCheckResolved = recorder
      .getEvents()
      .find((e) => e.eventType === "BlindnessCheckResolved")!;
    expect(blindnessCheckResolved.payload).toEqual({
      effectActionDefinitionId: blindDefId,
      effectInstanceId: blindEffectId,
      probability: 0.5,
      missed: true,
    });

    const skillMissed = recorder.getEvents().find((e) => e.eventType === "SkillMissed")!;
    expect(skillMissed.payload).toEqual({
      skillDefinitionId: context.skillDefinitionId,
      missedByEffectInstanceIds: [blindEffectId],
    });
  });

  it("UT-R-HIT-03-009 (R-HIT-03/R-STS-04, Issue #183): an actor whose BLIND effect roll does NOT miss still records BlindnessCheckResolved, but the EffectSequence proceeds normally", () => {
    const blindEffectId = createEffectInstanceId("blind-1");
    const blindDefId = createEffectActionDefinitionId("ACT_BLIND");
    const actor = unit("ACTOR", "ALLY", {
      appliedEffects: [
        {
          effectInstanceId: blindEffectId,
          effectActionDefinitionId: blindDefId,
          kindKey: effectKindKeyFromDefinitionId(blindDefId),
          duplicate: true,
          sourceId: createBattleUnitId("SOURCE"),
          targetId: createBattleUnitId("ACTOR"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "BLIND",
          statusDetails: { probability: 0.5 },
          duration: {
            definition: {
              timeLimit: { unit: "ACTION", count: 2 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            timeLimitRemaining: 2,
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const enemy = unit("ENEMY", "ENEMY");
    const statMod = statModAction("ACT_ATK_UP");
    const effectActions = new Map([[statMod.effectActionDefinitionId, statMod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context: EffectActionGroupContext = {
      ...contextFor(actor, effectActions, recorder, rootEventId),
      random: new SequenceRandomSource([0.9]),
    };
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
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
      "BlindnessCheckResolved",
      "EffectStepStarting",
      "EffectActionStarting",
      "EffectApplied",
      "CombatStatChanged",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);
    expect(
      result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!.appliedEffects,
    ).toHaveLength(1);
  });

  it("UT-R-STS-02-004 (R-SKL-05/R-STS-02, Issue #180): granting STUN to a unit with a pending charge cancels it and records ChargeCancelled", () => {
    const actor = unit("ACTOR", "ALLY");
    const chargedSkill = skillOf({ kind: "IMMEDIATE", targetBindings: [], steps: [] });
    const startedActionId = createActionId("B_TEST:action:1");
    const enemy = unit("ENEMY", "ENEMY", {
      charge: { skill: chargedSkill, startedActionId },
    });
    const stun: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[stun.effectActionDefinitionId, stun]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.charge).toBeUndefined();
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]).toMatchObject({ statusKind: "STUN" });

    const cancelled = recorder
      .getEvents()
      .find((e) => e.eventType === "ChargeCancelled") as Extract<
      BattleDomainEvent,
      { eventType: "ChargeCancelled" }
    >;
    expect(cancelled).toBeDefined();
    expect(cancelled.payload).toMatchObject({
      actorUnitId: enemy.battleUnitId,
      skillDefinitionId: chargedSkill.skillDefinitionId,
      startedActionId,
      reason: "STUN",
    });
  });

  it("UT-R-STS-02-005 (R-STS-02, Issue #180): granting STUN to a unit without a pending charge records no ChargeCancelled", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const stun: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const effectActions = new Map([[stun.effectActionDefinitionId, stun]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(recorder.getEvents().some((e) => e.eventType === "ChargeCancelled")).toBe(false);
  });

  it("UT-R-STS-01-001 (R-STS-01 '状態異常はデバフの一種とする'): a real, production-granted STUN AppliedEffect is removed by a REMOVE_EFFECTS(categories: DEBUFF) ACTION step", () => {
    const actor = unit("ACTOR", "ALLY");
    const stunDefId = createEffectActionDefinitionId("ACT_STUN");
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("stun-1"),
          effectActionDefinitionId: stunDefId,
          kindKey: effectKindKeyFromDefinitionId(stunDefId),
          duplicate: true,
          sourceId: createBattleUnitId("SOURCE"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["DEBUFF", "STATUS"],
          statusKind: "STUN",
          duration: {
            definition: {
              timeLimit: { unit: "ACTION", count: 1 },
              dispellable: true,
              linkedEffectGroupId: null,
            },
            timeLimitRemaining: 1,
          },
          appliedTurnNumber: 1,
        },
      ],
    });
    const stunDef: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: stunDefId,
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const remove: EffectActionDefinition = {
      kind: "REMOVE_EFFECTS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_CLEANSE_DEBUFF"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: { categories: ["DEBUFF"] },
    };
    const effectActions = new Map<
      ReturnType<typeof createEffectActionDefinitionId>,
      EffectActionDefinition
    >([
      [stunDef.effectActionDefinitionId, stunDef],
      [remove.effectActionDefinitionId, remove],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, remove.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(0);
    const removed = recorder.getEvents().find((e) => e.eventType === "EffectRemoved") as Extract<
      BattleDomainEvent,
      { eventType: "EffectRemoved" }
    >;
    expect(removed.payload).toMatchObject({
      effectInstanceId: createEffectInstanceId("stun-1"),
      battleUnitId: enemy.battleUnitId,
      reason: "REMOVED",
    });
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
        stacking: { mode: "STACKABLE", max: null },
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
      stealthConsumptions: [],
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
        stacking: { mode: "STACKABLE", max: null },
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
      stealthConsumptions: [],
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
        stacking: { mode: "STACKABLE", max: null },
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
      categories: ["BUFF"],
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
      stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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

    it("UT-R-ACTN-01-002B (PR #262レビュー[P2]): APPLY_MARKER rejects a context that has neither an actor BattleUnit nor a Memory source side, instead of granting a MarkerState with no recorded granter", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const markerId = createMarkerId("MARKER_TEST");
      const apply = markerAction("ACT_APPLY_MARKER", markerId);
      const effectActions = new Map([[apply.effectActionDefinitionId, apply]]);
      const { recorder, rootEventId } = seedRecorder();
      // R-EFF-10「直近の付与者」はexactly-one（`MarkerSource`）。実経路では
      // スキル解決が`actorId`を、Memory解決（R-MEM-04）が`sourceSide`を必ず持つが、
      // 型だけでは両方欠落を防げないためこの境界で決定的に拒否する。
      const { actorId: _actorId, ...withoutSource } = contextFor(
        actor,
        effectActions,
        recorder,
        rootEventId,
      );
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, enemy.battleUnitId, apply.effectActionDefinitionId)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: new Map(),
      };

      expect(() => applyEffectActionGroups(plan, [actor, enemy], withoutSource)).toThrow(
        DomainValidationError,
      );
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: bindingTarget,
            actions: [{ effectActionDefinitionId: lethalHit.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
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
        stealthConsumptions: [],
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
        "DamageWillBeApplied",
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
        stealthConsumptions: [],
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: firstBindingId },
            actions: [{ effectActionDefinitionId: grantMarker.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
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
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
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

  describe("POST_DAMAGE_CRITICAL_BRANCH / POST_DAMAGE_SURVIVAL_BRANCH（DMG-003、Issue #196）", () => {
    /** `critical.mode: GUARANTEED`のDAMAGE（乱数を消費せず必ず会心する、R-CRT-02）。 */
    function guaranteedCriticalDamage(id: string, hitCount = 1): EffectActionDefinition {
      const base = damageAction(id, hitCount);
      if (base.kind !== "DAMAGE") {
        throw new Error("expected DAMAGE");
      }
      return { ...base, payload: { ...base.payload, critical: { mode: "GUARANTEED" } } };
    }

    function completedActionIdsOf(recorder: EventRecorder): readonly unknown[] {
      return recorder
        .getEvents()
        .filter((e) => e.eventType === "EffectActionCompleted")
        .map((e) => e.payload.effectActionDefinitionId);
    }

    it("UT-R-SKL-08-022: LAST_RESULT criticalHitCount is scoped to the whole preceding ACTION step, not to its last EffectAction application", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const attack = guaranteedCriticalDamage("ACT_AOE_CRIT");
      // `SKL_FEE_BATH_AS2`と同じ形（1つのACTION stepがDAMAGEとMARKERを順に持つ）。
      // R-SKL-06 #4より対象ごとにactionsを定義順で適用するため、このstepの
      // **最後**のapplicationは会心を持たないMARKER側になる。`criticalHitCount`が
      // 「最後に処理したapplication 1件」の値なら0になり elseSteps へ倒れる —
      // per-applicationとstep-wideを区別する識別子はこの並びである。
      const tailMarker = markerAction("ACT_TAIL", createMarkerId("MARKER_TAIL"));
      const thenAction = markerAction("ACT_THEN", createMarkerId("MARKER_THEN"));
      const elseAction = markerAction("ACT_ELSE", createMarkerId("MARKER_ELSE"));
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
        [tailMarker.effectActionDefinitionId, tailMarker],
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
          {
            kind: "ACTION",
            stepCondition: { kind: "TRUE" },
            targetCondition: { kind: "TRUE" },
            target: enemyTarget,
            actions: [
              { effectActionDefinitionId: attack.effectActionDefinitionId },
              { effectActionDefinitionId: tailMarker.effectActionDefinitionId },
            ],
          },
          {
            kind: "BRANCH",
            condition: { kind: "LAST_RESULT", field: "criticalHitCount", op: "GTE", value: 1 },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const units = [actor, enemyA, enemyB];
      const plan = resolveSkillOrder(skill, actor, units, effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(plan, units, contextFor(actor, effectActions, recorder, rootEventId));

      const completed = completedActionIdsOf(recorder);
      expect(completed).toContain(thenAction.effectActionDefinitionId);
      expect(completed).not.toContain(elseAction.effectActionDefinitionId);
    });

    it("UT-R-SKL-08-023: LAST_RESULT criticalHitCount stays 0 when the preceding DAMAGE step could not crit, so elseSteps run", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY_A", "ENEMY");
      // `damageAction`の既定は`critical.mode: PREVENTED`（会心しない）。
      const attack = damageAction("ACT_NO_CRIT", 3);
      const thenAction = markerAction("ACT_THEN", createMarkerId("MARKER_THEN"));
      const elseAction = markerAction("ACT_ELSE", createMarkerId("MARKER_ELSE"));
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
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
          actionOn(enemyTarget, attack.effectActionDefinitionId),
          {
            kind: "BRANCH",
            condition: { kind: "LAST_RESULT", field: "criticalHitCount", op: "GTE", value: 1 },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const units = [actor, enemy];
      const plan = resolveSkillOrder(skill, actor, units, effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(plan, units, contextFor(actor, effectActions, recorder, rootEventId));

      const completed = completedActionIdsOf(recorder);
      expect(completed).toContain(elseAction.effectActionDefinitionId);
      expect(completed).not.toContain(thenAction.effectActionDefinitionId);
    });

    it("UT-R-SKL-08-024: a BRANCH counting DEFEATED members of LAST_ACTION_TARGETS fires when the preceding AOE killed any one of them", () => {
      const actor = unit("ACTOR", "ALLY");
      const frail = unit("ENEMY_A", "ENEMY", { currentHp: 1 });
      const sturdy = unit("ENEMY_B", "ENEMY");
      const attack = damageAction("ACT_AOE");
      const thenAction = markerAction("ACT_THEN", createMarkerId("MARKER_THEN"));
      const elseAction = markerAction("ACT_ELSE", createMarkerId("MARKER_ELSE"));
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
        [thenAction.effectActionDefinitionId, thenAction],
        [elseAction.effectActionDefinitionId, elseAction],
      ]);

      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyTarget: TargetReference = { kind: "BINDING", targetBindingId: enemyBindingId };
      // `LAST_ACTION_TARGETS`は直前ACTION stepが実際に対象にしたunit集合を、
      // 戦闘不能になった対象も含めて指す — `TGT_ENEMY`をそのまま数え直すと
      // 生存者だけへ縮んでしまい「倒した」ことが観測できない。
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
          actionOn(enemyTarget, attack.effectActionDefinitionId),
          {
            kind: "BRANCH",
            condition: {
              kind: "TARGET_SET_COUNT",
              target: { kind: "LAST_ACTION_TARGETS" },
              countOf: "DEFEATED",
              op: "GTE",
              value: 1,
            },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const units = [actor, frail, sturdy];
      const plan = resolveSkillOrder(skill, actor, units, effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(plan, units, contextFor(actor, effectActions, recorder, rootEventId));

      const completed = completedActionIdsOf(recorder);
      expect(completed).toContain(thenAction.effectActionDefinitionId);
      expect(completed).not.toContain(elseAction.effectActionDefinitionId);
    });

    it("UT-R-SKL-08-025: the same DEFEATED branch does not fire when every attacked target survived", () => {
      const actor = unit("ACTOR", "ALLY");
      const sturdyA = unit("ENEMY_A", "ENEMY");
      const sturdyB = unit("ENEMY_B", "ENEMY");
      const attack = damageAction("ACT_AOE");
      const thenAction = markerAction("ACT_THEN", createMarkerId("MARKER_THEN"));
      const elseAction = markerAction("ACT_ELSE", createMarkerId("MARKER_ELSE"));
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
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
          actionOn(enemyTarget, attack.effectActionDefinitionId),
          {
            kind: "BRANCH",
            condition: {
              kind: "TARGET_SET_COUNT",
              target: { kind: "LAST_ACTION_TARGETS" },
              countOf: "DEFEATED",
              op: "GTE",
              value: 1,
            },
            thenSteps: [actionOn({ kind: "SELF" }, thenAction.effectActionDefinitionId)],
            elseSteps: [actionOn({ kind: "SELF" }, elseAction.effectActionDefinitionId)],
          },
        ],
      });

      const units = [actor, sturdyA, sturdyB];
      const plan = resolveSkillOrder(skill, actor, units, effectActions);
      const { recorder, rootEventId } = seedRecorder();
      applyEffectActionGroups(plan, units, contextFor(actor, effectActions, recorder, rootEventId));

      const completed = completedActionIdsOf(recorder);
      expect(completed).toContain(elseAction.effectActionDefinitionId);
      expect(completed).not.toContain(thenAction.effectActionDefinitionId);
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
            condition: {
              kind: "TARGET_SET_COUNT",
              target: enemyTarget,
              countOf: "ALIVE",
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
            condition: {
              kind: "TARGET_SET_COUNT",
              target: enemyTarget,
              countOf: "ALIVE",
              op: "GTE",
              value: 1,
            },
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
            condition: {
              kind: "TARGET_SET_COUNT",
              target: enemyTarget,
              countOf: "ALIVE",
              op: "GTE",
              value: 2,
            },
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
            stepCondition: {
              kind: "TARGET_SET_COUNT",
              target: enemyTarget,
              countOf: "ALIVE",
              op: "GTE",
              value: 1,
            },
            targetCondition: { kind: "TRUE" },
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
              countOf: "ALIVE",
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

    it("UT-R-SKL-06-039（PRレビュー[P1]再指摘）: an ACTION step's own (non-self-referencing) TARGET_SET_COUNT condition is re-evaluated after its own EffectStepStarting's PS-style chain empties the referenced set, not before it is emitted", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const conditionalHit = damageAction("ACT_CONDITIONAL_HIT");
      const effectActions = new Map([[conditionalHit.effectActionDefinitionId, conditionalHit]]);

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
          {
            kind: "ACTION",
            stepCondition: {
              kind: "TARGET_SET_COUNT",
              target: enemyTarget,
              countOf: "ALIVE",
              op: "GTE",
              value: 1,
            },
            targetCondition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      // Simulates a PS reacting to this very ACTION step's own `EffectStepStarting`
      // (TIMING, stepIndex 0) by defeating enemyA — before this chain runs,
      // TGT_ENEMY resolves 1 alive member (`GTE 1` would be true). Evaluating the
      // condition before `EffectStepStarting` is emitted (instead of after, via
      // `resolveAfterTiming`) would miss this and incorrectly start the action.
      const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
        if (event.eventType !== "EffectStepStarting" || event.payload.stepIndex !== 0) {
          return units;
        }
        return units.map((u) =>
          u.battleUnitId === enemyA.battleUnitId ? { ...u, currentHp: 0 } : u,
        );
      });

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
  });

  describe("CAP_EFFECT_STEP_CONDITION_SCOPE（Issue #230 RES-004-CONDITION-SCOPE）: an ACTION step's stepCondition (step-wide gate) and targetCondition (per-target filter) are independent and can be combined on the same step", () => {
    function completedTargetsFor(
      recorder: EventRecorder,
      effectActionDefinitionId: string,
    ): readonly string[] {
      return recorder
        .getEvents()
        .filter(
          (e): e is Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }> =>
            e.eventType === "EffectActionCompleted" &&
            e.payload.effectActionDefinitionId === effectActionDefinitionId,
        )
        .flatMap((e) => e.payload.targetUnitIds);
    }

    function twoEnemyMarkerGateSkill(
      stepConditionValue: number,
      grantMarkerTo: "enemyA" | "none" | "both",
      markerId = createMarkerId("MARKER_TEST"),
    ) {
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
      // R-TGT-02（`unit()`は全員同じ位置に置くため入力順でタイブレークする、
      // `UT-R-TGT-10-009`/`UT-R-SKL-06-022`と同じ前提）: TGT_FIRSTは常に
      // enemyA（`allUnits`の先頭の敵）に束縛される。
      const grantSteps: EffectStepDefinition[] =
        grantMarkerTo === "none"
          ? []
          : [
              {
                kind: "ACTION",
                stepCondition: { kind: "TRUE" },
                targetCondition: { kind: "TRUE" },
                target:
                  grantMarkerTo === "both"
                    ? allTarget
                    : { kind: "BINDING", targetBindingId: firstBindingId },
                actions: [{ effectActionDefinitionId: grantMarker.effectActionDefinitionId }],
              },
            ];
      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: firstBindingId, selector: enemySelector(1) },
          { targetBindingId: allBindingId, selector: enemySelector("ALL") },
        ],
        steps: [
          ...grantSteps,
          {
            kind: "ACTION",
            // step-wide gate（Issue #227 CAP_EFFECT_STEP_SET_CONDITION）:
            // TGT_ALLの生存数がstepConditionValue以上でなければstep全体をskipする。
            stepCondition: {
              kind: "TARGET_SET_COUNT",
              countOf: "ALIVE",
              target: allTarget,
              op: "GTE",
              value: stepConditionValue,
            },
            // per-target filter（CAP_EFFECT_STEP_CONDITION）: markerを持つ対象だけに絞る。
            // Issue #227まではこの2つを同じconditionツリーへ同時に持たせること自体が
            // MIXED_STEP_TARGET_SET_CONDITIONとしてCatalogロード時点で拒否されていた。
            targetCondition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
            target: allTarget,
            actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
          },
        ],
      });
      return { skill, effectActions, conditionalHit };
    }

    /**
     * PRレビュー[P2]（Issue #230）: `UT-R-SKL-06-040`〜`043`はいずれもトップ
     * レベルのACTIONだけを検証していた。`resolveRawStep`のACTIONケースは
     * `resolveStepDefinitionList`経由でBRANCH/REPEAT/RANDOM_BRANCHの内側からも
     * 同じ関数で呼ばれるため（`effect-action-group-resolver.ts`の設計上、
     * ネストの有無で処理を分けていない）、combined stepCondition/targetCondition
     * を持つACTIONがBRANCH.thenSteps/REPEAT.steps/RANDOM_BRANCHのbranch.steps
     * それぞれの内側でも同じ経路をたどることを明示的に検証する。
     */
    function nestedCombinedConditionSkill(container: "BRANCH" | "REPEAT" | "RANDOM_BRANCH") {
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
      const grantStep: EffectStepDefinition = {
        kind: "ACTION",
        stepCondition: { kind: "TRUE" },
        targetCondition: { kind: "TRUE" },
        target: { kind: "BINDING", targetBindingId: firstBindingId },
        actions: [{ effectActionDefinitionId: grantMarker.effectActionDefinitionId }],
      };
      // combined stepCondition（TARGET_SET_COUNT）/targetCondition
      // （TARGET_HAS_MARKER）を持つ、ネストされる側のACTION本体。
      const combinedAction: EffectStepDefinition = {
        kind: "ACTION",
        stepCondition: {
          kind: "TARGET_SET_COUNT",
          target: allTarget,
          countOf: "ALIVE",
          op: "GTE",
          value: 2,
        },
        targetCondition: { kind: "TARGET_HAS_MARKER", target: allTarget, markerId },
        target: allTarget,
        actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
      };
      const nestedStep: EffectStepDefinition =
        container === "BRANCH"
          ? {
              kind: "BRANCH",
              condition: { kind: "TRUE" },
              thenSteps: [combinedAction],
              elseSteps: [],
            }
          : container === "REPEAT"
            ? { kind: "REPEAT", count: 2, steps: [combinedAction] }
            : {
                kind: "RANDOM_BRANCH",
                mode: "INDEPENDENT",
                branches: [{ probability: 1, steps: [combinedAction] }],
              };

      const skill = skillOf({
        kind: "IMMEDIATE",
        targetBindings: [
          { targetBindingId: firstBindingId, selector: enemySelector(1) },
          { targetBindingId: allBindingId, selector: enemySelector("ALL") },
        ],
        steps: [grantStep, nestedStep],
      });
      return { skill, effectActions, conditionalHit };
    }

    it("UT-R-SKL-06-049: a combined stepCondition/targetCondition ACTION nested inside BRANCH.thenSteps resolves through the same unified path as a top-level ACTION", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const { skill, effectActions, conditionalHit } = nestedCombinedConditionSkill("BRANCH");

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      expect([...completedTargetsFor(recorder, conditionalHit.effectActionDefinitionId)]).toEqual([
        enemyA.battleUnitId,
      ]);
    });

    it("UT-R-SKL-06-050: a combined stepCondition/targetCondition ACTION nested inside REPEAT.steps resolves identically on every iteration", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const { skill, effectActions, conditionalHit } = nestedCombinedConditionSkill("REPEAT");

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      // count: 2のREPEATが2回とも同じ判定(gate true、filterはenemyAだけ)を
      // 再現するため、conditionalHitはenemyAに対して2回完了する。
      expect([...completedTargetsFor(recorder, conditionalHit.effectActionDefinitionId)]).toEqual([
        enemyA.battleUnitId,
        enemyA.battleUnitId,
      ]);
    });

    it("UT-R-SKL-06-051: a combined stepCondition/targetCondition ACTION nested inside a RANDOM_BRANCH branch's steps resolves through the same unified path", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const { skill, effectActions, conditionalHit } =
        nestedCombinedConditionSkill("RANDOM_BRANCH");

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      // INDEPENDENTのprobability: 1でもcontext.random.next()は必ず1回消費される
      // （`resolveRandomBranchStep`）ため、`contextFor`のデフォルト`NO_RANDOM`
      // ではなく、branchを確実に成立させる`SequenceRandomSource`へ差し替える。
      const random = new SequenceRandomSource([0]);
      const context = { ...contextFor(actor, effectActions, recorder, rootEventId), random };
      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      expect([...completedTargetsFor(recorder, conditionalHit.effectActionDefinitionId)]).toEqual([
        enemyA.battleUnitId,
      ]);
    });

    it("UT-R-SKL-06-040: stepCondition true (enough survivors) and targetCondition true for every resolved target — both scopes pass, every target's action resolves normally", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const { skill, effectActions, conditionalHit } = twoEnemyMarkerGateSkill(2, "both");

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      expect(
        [...completedTargetsFor(recorder, conditionalHit.effectActionDefinitionId)].sort(),
      ).toEqual([enemyA.battleUnitId, enemyB.battleUnitId].sort());
      expect(recorder.getEvents().some((e) => e.eventType === "EffectStepSkipped")).toBe(false);
    });

    it("UT-R-SKL-06-041: stepCondition false (not enough survivors) skips the whole step (EffectStepSkipped, no EffectActionStarting) even for a target that would satisfy targetCondition", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      // 2体しかいないためGTE 3は常にfalse — enemyAはmarkerを持つ（targetConditionは
      // trueになるはず）が、gateがfalseならtargetConditionは一切評価されない。
      const { skill, effectActions, conditionalHit } = twoEnemyMarkerGateSkill(3, "enemyA");

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      expect(
        recorder
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === conditionalHit.effectActionDefinitionId,
          ),
      ).toBe(false);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectStepSkipped")).toBe(true);
    });

    it("UT-R-SKL-06-042: stepCondition true but targetCondition false for every resolved target produces a 0-target ACTION (SKIPPED LastResult visible to a following LAST_RESULT condition, EffectStepCompleted) rather than EffectStepSkipped", () => {
      // R-SKL-08: the 0-target SKIPPED "last result" is a runtime-only
      // LastResultState, not a domain event (`08_ドメインイベント.md`) — so it
      // must be observed indirectly through a following LAST_RESULT condition,
      // the same technique `UT-R-SKL-08-011` uses.
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const conditionalHit = damageAction("ACT_CONDITIONAL_HIT");
      const followUp = damageAction("ACT_FOLLOW_UP");
      const effectActions = new Map([
        [conditionalHit.effectActionDefinitionId, conditionalHit],
        [followUp.effectActionDefinitionId, followUp],
      ]);
      const enemyBindingId = createTargetBindingId("TGT_ENEMY");
      const enemyTarget: TargetReference = { kind: "BINDING", targetBindingId: enemyBindingId };
      const noMarkerId = createMarkerId("MARKER_NEVER_GRANTED");
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
          {
            kind: "ACTION",
            // step-wide gate: satisfied (both enemies alive).
            stepCondition: {
              kind: "TARGET_SET_COUNT",
              target: enemyTarget,
              countOf: "ALIVE",
              op: "GTE",
              value: 2,
            },
            // per-target filter: satisfied by nobody (marker never granted).
            targetCondition: {
              kind: "TARGET_HAS_MARKER",
              target: enemyTarget,
              markerId: noMarkerId,
            },
            target: enemyTarget,
            actions: [{ effectActionDefinitionId: conditionalHit.effectActionDefinitionId }],
          },
          {
            kind: "BRANCH",
            condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "SKIPPED" },
            thenSteps: [actionOn({ kind: "SELF" }, followUp.effectActionDefinitionId)],
            elseSteps: [],
          },
        ],
      });

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      const events = recorder.getEvents();
      expect(events.some((e) => e.eventType === "EffectStepSkipped")).toBe(false);
      expect(
        events.some(
          (e) =>
            e.eventType === "EffectActionStarting" &&
            e.payload.effectActionDefinitionId === conditionalHit.effectActionDefinitionId,
        ),
      ).toBe(false);
      expect(events.some((e) => e.eventType === "EffectStepCompleted")).toBe(true);
      expect(
        events.some(
          (e) =>
            e.eventType === "EffectActionStarting" &&
            e.payload.effectActionDefinitionId === followUp.effectActionDefinitionId,
        ),
      ).toBe(true);
    });

    it("UT-R-SKL-06-043: stepCondition true and targetCondition true for only some resolved targets applies the action to the matching subset only, leaving the rest untouched", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemyA = unit("ENEMY_A", "ENEMY");
      const enemyB = unit("ENEMY_B", "ENEMY");
      const { skill, effectActions, conditionalHit } = twoEnemyMarkerGateSkill(2, "enemyA");

      const plan = resolveSkillOrder(skill, actor, [actor, enemyA, enemyB], effectActions);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      applyEffectActionGroups(plan, [actor, enemyA, enemyB], context);

      expect([...completedTargetsFor(recorder, conditionalHit.effectActionDefinitionId)]).toEqual([
        enemyA.battleUnitId,
      ]);
    });
  });

  describe("BRANCH step-wide TARGET_STATE/TARGET_HAS_MARKER via resolveTargetSet (Issue #230 PRレビュー[P1]): a BRANCH condition referencing a guaranteed single-unit TargetReference (SELF/TRIGGER_SOURCE/count:1 BINDING) now resolves instead of throwing (previously `resolveBranchStep` always passed `targetContext: undefined`, so any such condition threw `DomainValidationError`)", () => {
    it("UT-R-SKL-07-111: a BRANCH's TARGET_STATE(SELF, HP_RATIO) condition is evaluated against the actor's own latest HP after EffectStepStarting's own chain, picking thenSteps when low and elseSteps when not", () => {
      const lowHpBonus = damageAction("ACT_LOW_HP_BONUS");
      const normalHit = damageAction("ACT_NORMAL");
      const effectActions = new Map([
        [lowHpBonus.effectActionDefinitionId, lowHpBonus],
        [normalHit.effectActionDefinitionId, normalHit],
      ]);
      const branch: EffectStepDefinition = {
        kind: "BRANCH",
        condition: {
          kind: "TARGET_STATE",
          target: { kind: "SELF" },
          field: "HP_RATIO",
          op: "LT",
          value: 0.5,
        },
        thenSteps: [
          actionOn(
            { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            lowHpBonus.effectActionDefinitionId,
          ),
        ],
        elseSteps: [
          actionOn(
            { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_1") },
            normalHit.effectActionDefinitionId,
          ),
        ],
      };

      const lowHpActor = unit("ACTOR_LOW", "ALLY", { currentHp: 40 });
      const enemy1 = unit("ENEMY_1", "ENEMY");
      const plan1: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [deferredStep(0, branch)],
        targetUnitIds: [enemy1.battleUnitId],
        resolvedBindings: new Map([
          [createTargetBindingId("TGT_1"), { units: [enemy1], includeDefeated: false }],
        ]),
      };
      const { recorder: recorder1, rootEventId: rootEventId1 } = seedRecorder();
      const context1 = contextFor(lowHpActor, effectActions, recorder1, rootEventId1);
      applyEffectActionGroups(plan1, [lowHpActor, enemy1], context1);
      expect(
        recorder1
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === lowHpBonus.effectActionDefinitionId,
          ),
      ).toBe(true);
      expect(
        recorder1
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === normalHit.effectActionDefinitionId,
          ),
      ).toBe(false);

      const fullHpActor = unit("ACTOR_FULL", "ALLY");
      const enemy2 = unit("ENEMY_2", "ENEMY");
      const plan2: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [deferredStep(0, branch)],
        targetUnitIds: [enemy2.battleUnitId],
        resolvedBindings: new Map([
          [createTargetBindingId("TGT_1"), { units: [enemy2], includeDefeated: false }],
        ]),
      };
      const { recorder: recorder2, rootEventId: rootEventId2 } = seedRecorder();
      const context2 = contextFor(fullHpActor, effectActions, recorder2, rootEventId2);
      applyEffectActionGroups(plan2, [fullHpActor, enemy2], context2);
      expect(
        recorder2
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === normalHit.effectActionDefinitionId,
          ),
      ).toBe(true);
      expect(
        recorder2
          .getEvents()
          .some(
            (e) =>
              e.eventType === "EffectActionStarting" &&
              e.payload.effectActionDefinitionId === lowHpBonus.effectActionDefinitionId,
          ),
      ).toBe(false);
    });
  });

  describe("MODIFY_RESOURCE (R-ACTN-02, M7-002 Issue #185, HP_DIRECT_COST full-stack wiring)", () => {
    function modifyResourceAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "MODIFY_RESOURCE" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "MODIFY_RESOURCE",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    it("UT-R-ACTN-02-008 (full stack): a self-targeted MODIFY_RESOURCE(resource: HP, ADD, MAX_HP_RATIO -10%) reduces the actor's own HP through the real effect-action-group-resolver.ts wiring, recording ResourceChanged(reason: EFFECT_ACTION)", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 100 });
      const cost = modifyResourceAction("ACT_HP_COST", {
        resource: "HP",
        operation: "ADD",
        formula: { kind: "MAX_HP_RATIO", source: { kind: "SKILL_SOURCE" }, ratio: -0.1 },
      });
      const effectActions = new Map([[cost.effectActionDefinitionId, cost]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, cost.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.currentHp).toBe(90);

      const resourceChanged = recorder.getEvents().find((e) => e.eventType === "ResourceChanged")!;
      expect(resourceChanged.payload).toMatchObject({
        battleUnitId: actor.battleUnitId,
        resource: "HP",
        before: 100,
        after: 90,
        delta: -10,
        baseDelta: -10,
        reason: "EFFECT_ACTION",
      });
      expect(resourceChanged.stateDelta).toEqual({
        units: { [actor.battleUnitId]: { hp: { before: 100, after: 90 } } },
      });
    });

    it("UT-R-ACTN-02-019 (full stack, DISTRIBUTE): one total EX amount is split evenly across every target of the same EffectAction in the step instead of granting each target the full amount", () => {
      const actor = unit("ACTOR", "ALLY");
      const ally = unit("ALLY_2", "ALLY");
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, ally, distribute, false);

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      for (const target of [actor, ally]) {
        expect(
          result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentExtraGauge,
        ).toBe(4);
      }
      const changes = recorder.getEvents().filter((e) => e.eventType === "ResourceChanged");
      expect(changes).toHaveLength(2);
      expect(changes[0]!.stateDelta).toEqual({
        units: { [actor.battleUnitId]: { extraGauge: { before: 0, after: 4 } } },
      });
    });

    it("UT-R-ACTN-02-020 (BOUNDARY): a target that is already defeated when the distributing MODIFY_RESOURCE starts is excluded from the share count, so the surviving target still receives the whole total", () => {
      const actor = unit("ACTOR", "ALLY");
      // The EffectStepStarting chain can leave a planned target defeated. The
      // EffectAction is then SKIPPED for it, so it must not consume a share.
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, deadAlly, distribute, false);

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      expect(
        result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentExtraGauge,
      ).toBe(8);
      expect(
        result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentExtraGauge,
      ).toBe(0);
      expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(1);
    });

    it("UT-R-ACTN-02-021 (BOUNDARY): a defeated target selected with includeDefeated stays in the share count, because unlike HEAL a MODIFY_RESOURCE really does apply to it", () => {
      const actor = unit("ACTOR", "ALLY");
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, deadAlly, distribute, true);

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      // Both targets receive a share, so the total really is divided by 2.
      expect(
        result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentExtraGauge,
      ).toBe(4);
      expect(
        result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentExtraGauge,
      ).toBe(4);
      expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(2);
    });

    it("UT-R-ACTN-02-022 (PRレビュー[P2] PR #282): a step that references the same DISTRIBUTE EffectAction twice distributes one total per reference, not one total shared by both references", () => {
      const actor = unit("ACTOR", "ALLY");
      const ally = unit("ALLY_2", "ALLY");
      const distribute = modifyResourceAction("ACT_EX_DISTRIBUTE", {
        resource: "EX_GAUGE",
        operation: "DISTRIBUTE",
        formula: { kind: "CONSTANT", value: 8 },
        bounds: { min: 0, max: "CURRENT_MAX" },
      });
      const effectActions = new Map([[distribute.effectActionDefinitionId, distribute]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan = distributePlan(actor, ally, distribute, false, 2);

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      // R-SKL-06 #4: 各`EffectActionReference`は独立して適用される。参照ごとに
      // 総量8を対象2体へ等分（各4）するため、対象は4を2回受け取り+8になる。
      // 4 application全体を1つの分配として数えると各対象+4にしかならない。
      for (const target of [actor, ally]) {
        expect(
          result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentExtraGauge,
        ).toBe(8);
      }
      expect(recorder.getEvents().filter((e) => e.eventType === "ResourceChanged")).toHaveLength(4);
    });

    /**
     * 1つのACTION stepで、同じEffectActionを`referenceCount`回参照し、
     * actorとotherの2対象へ適用する計画。`skill-resolution-service.ts`の
     * `buildApplications`と同じ「対象ごとに`actions`を定義順で並べる」順序で
     * applicationを並べる。
     */
    function distributePlan(
      actor: BattleUnit,
      other: BattleUnit,
      action: EffectActionDefinition,
      includeDefeated: boolean,
      referenceCount = 1,
    ): EffectSequencePlan {
      const step = singleActionStep(0, true, actor.battleUnitId, action.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const applicationFor = (
        target: BattleUnit,
        hitIndex: number,
      ): (typeof step.applications)[number] => ({
        targetBattleUnitId: target.battleUnitId,
        effectActionDefinitionId: action.effectActionDefinitionId,
        includeDefeated: target.battleUnitId === actor.battleUnitId ? false : includeDefeated,
        hits: [
          {
            targetBattleUnitId: target.battleUnitId,
            effectActionDefinitionId: action.effectActionDefinitionId,
            hitIndex,
          },
        ],
      });
      const references = Array.from({ length: referenceCount }, () => ({
        effectActionDefinitionId: action.effectActionDefinitionId,
      }));
      return {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            actions: references,
            applications: [actor, other].flatMap((target) =>
              references.map((_, index) => applicationFor(target, index + 1)),
            ),
          },
        ],
        targetUnitIds: [actor.battleUnitId, other.battleUnitId],
        resolvedBindings: new Map(),
      };
    }
  });

  describe("HEAL / APPLY_HEALING_MOD / APPLY_CONTINUOUS_HEAL (R-HEAL-01〜03, M7-005 Issue #184)", () => {
    function healAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "HEAL" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    function healingModAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "APPLY_HEALING_MOD" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "APPLY_HEALING_MOD",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    function continuousHealAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "APPLY_CONTINUOUS_HEAL" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "APPLY_CONTINUOUS_HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    function healingLinkAction(id: string, transferRate = 1): EffectActionDefinition {
      return {
        kind: "APPLY_HEALING_LINK",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          transferTo: { kind: "SELF" },
          transferRate,
          duration: {
            timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
            dispellable: true,
            linkedEffectGroupId: null,
          },
        },
      };
    }

    it("UT-R-HEAL-01-007 (full stack): a HEAL EffectAction raises the target's HP and emits HealApplied through the real effect-action-group-resolver.ts wiring", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 50 });
      const heal = healAction("ACT_HEAL", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
        overheal: "DISCARD",
        distribution: "NONE",
      });
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(80);
      const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
      expect(healApplied.payload).toMatchObject({
        effectActionDefinitionId: heal.effectActionDefinitionId,
        targetUnitId: actor.battleUnitId,
        healAmount: 30,
        appliedAmount: 30,
      });
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("APPLIED");
    });

    it("UT-R-HEAL-02-001 (full stack): an APPLY_HEALING_MOD grants an AppliedEffect whose magnitude is the evaluated signed rate", () => {
      const actor = unit("ACTOR", "ALLY");
      const mod = healingModAction("ACT_HEAL_UP", {
        direction: "INCOMING",
        formula: { kind: "CONSTANT", value: 0.15 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const effectActions = new Map([[mod.effectActionDefinitionId, mod]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, mod.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: mod.effectActionDefinitionId,
        magnitude: 0.15,
        duplicate: true,
      });
    });

    it("UT-R-HEAL-04-004 (full stack, R-HEAL-04): an APPLY_HEALING_LINK grants an AppliedEffect whose healingLink resolves transferTo: SELF to the granter at grant time", () => {
      const actor = unit("ACTOR", "ALLY");
      const holder = unit("HOLDER", "ENEMY");
      const link = healingLinkAction("ACT_LINK");
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, holder.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [holder.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, holder], context);

      const updated = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: link.effectActionDefinitionId,
        duplicate: true,
        healingLink: { transferToUnitId: actor.battleUnitId, transferRate: 1 },
      });
      const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied")!;
      expect(applied.payload).toMatchObject({
        targetUnitId: holder.battleUnitId,
        sourceUnitId: actor.battleUnitId,
      });
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("APPLIED");
    });

    function damageLinkAction(
      id: string,
      linkTo: Extract<EffectActionDefinition, { kind: "APPLY_DAMAGE_LINK" }>["payload"]["linkTo"],
      linkRate = 0.5,
    ): EffectActionDefinition {
      return {
        kind: "APPLY_DAMAGE_LINK",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          linkTo,
          linkRate,
          duration: {
            timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
            dispellable: false,
            linkedEffectGroupId: null,
          },
        },
      };
    }

    it("UT-R-LNK-01-001 (full stack, R-LNK-01): an APPLY_DAMAGE_LINK grants an AppliedEffect whose damageLink resolves linkTo: SELF to the granter at grant time", () => {
      const actor = unit("ACTOR", "ALLY");
      const holder = unit("HOLDER", "ALLY");
      const link = damageLinkAction("ACT_LINK", { kind: "SELF" });
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, holder.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [holder.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, holder], context);

      const updated = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: link.effectActionDefinitionId,
        duplicate: true,
        damageLink: { linkToUnitId: actor.battleUnitId, linkRate: 0.5 },
      });
      // R-EFF-02/03: リンクは保持者の被弾を波及させる不利な状態のため`DEBUFF`。
      expect(updated.appliedEffects[0]!.categories).toContain("DEBUFF");
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("APPLIED");
    });

    it("UT-R-LNK-01-002 (full stack, R-LNK-01): a BINDING linkTo resolves to the unit that binding selected, so a mutual link can name the other side", () => {
      const actor = unit("ACTOR", "ALLY");
      const nearest = unit("NEAREST", "ENEMY");
      const farthest = unit("FARTHEST", "ENEMY");
      const link = damageLinkAction(
        "ACT_LINK",
        { kind: "BINDING", targetBindingId: createTargetBindingId("TGT_FARTHEST") },
        0.35,
      );
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, nearest.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [nearest.battleUnitId],
        resolvedBindings: new Map([
          [createTargetBindingId("TGT_FARTHEST"), { units: [farthest], includeDefeated: false }],
        ]),
      };

      const result = applyEffectActionGroups(plan, [actor, nearest, farthest], context);

      const updated = result.units.find((u) => u.battleUnitId === nearest.battleUnitId)!;
      expect(updated.appliedEffects[0]).toMatchObject({
        damageLink: { linkToUnitId: farthest.battleUnitId, linkRate: 0.35 },
      });
    });

    it("UT-R-LNK-01-003 (full stack, R-LNK-01, NEGATIVE): a BINDING linkTo that resolved to no unit grants nothing and reports SKIPPED", () => {
      const actor = unit("ACTOR", "ALLY");
      const holder = unit("HOLDER", "ENEMY");
      const link = damageLinkAction("ACT_LINK", {
        kind: "BINDING",
        targetBindingId: createTargetBindingId("TGT_FARTHEST"),
      });
      const effectActions = new Map([[link.effectActionDefinitionId, link]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, holder.battleUnitId, link.effectActionDefinitionId)],
        targetUnitIds: [holder.battleUnitId],
        resolvedBindings: new Map([
          [createTargetBindingId("TGT_FARTHEST"), { units: [], includeDefeated: false }],
        ]),
      };

      const result = applyEffectActionGroups(plan, [actor, holder], context);

      expect(
        result.units.find((u) => u.battleUnitId === holder.battleUnitId)!.appliedEffects,
      ).toHaveLength(0);
      expect(
        recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload
          .resultKind,
      ).toBe("SKIPPED");
    });

    it("UT-R-HEAL-02-002 (full stack): the target's INCOMING healing modifiers scale the heal amount before truncation", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const mod = healingModAction("ACT_HEAL_UP", {
        direction: "INCOMING",
        formula: { kind: "CONSTANT", value: 0.15 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const heal = healAction("ACT_HEAL", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
        overheal: "DISCARD",
        distribution: "NONE",
      });
      const effectActions = new Map([
        [mod.effectActionDefinitionId, mod],
        [heal.effectActionDefinitionId, heal],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          singleActionStep(0, true, actor.battleUnitId, mod.effectActionDefinitionId),
          singleActionStep(1, true, actor.battleUnitId, heal.effectActionDefinitionId),
        ],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      // 30 * 1.15 = 34.5 -> truncated once, at application time, to 34
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(44);
      expect(
        recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload,
      ).toMatchObject({ healingModifierMultiplier: 1.15, healAmount: 34 });
    });

    it("UT-R-HEAL-02-003 (BOUNDARY): stacked negative healing modifiers below -100% clamp the multiplier at 0 instead of draining HP", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const block = healingModAction("ACT_HEAL_BLOCK", {
        direction: "INCOMING",
        formula: { kind: "CONSTANT", value: -1 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const heal = healAction("ACT_HEAL", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.3 },
        overheal: "DISCARD",
        distribution: "NONE",
      });
      const effectActions = new Map([
        [block.effectActionDefinitionId, block],
        [heal.effectActionDefinitionId, heal],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          singleActionStep(0, true, actor.battleUnitId, block.effectActionDefinitionId),
          singleActionStep(1, true, actor.battleUnitId, block.effectActionDefinitionId),
          singleActionStep(2, true, actor.battleUnitId, heal.effectActionDefinitionId),
        ],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(10);
      expect(
        recorder.getEvents().find((e) => e.eventType === "HealApplied")!.payload,
      ).toMatchObject({ healingModifierMultiplier: 0, healAmount: 0 });
    });

    it("UT-R-HEAL-03-001 (full stack): an APPLY_CONTINUOUS_HEAL grants an AppliedEffect that keeps its duration and is not applied immediately", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 50 });
      const hot = continuousHealAction("ACT_HOT", {
        formula: { kind: "MAX_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.1 },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const effectActions = new Map([[hot.effectActionDefinitionId, hot]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, hot.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updated.currentHp).toBe(50);
      expect(updated.appliedEffects).toHaveLength(1);
      expect(updated.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: hot.effectActionDefinitionId,
        duplicate: true,
      });
      expect(updated.appliedEffects[0]!.duration.timeLimitRemaining).toBe(2);
      expect(recorder.getEvents().some((e) => e.eventType === "HealApplied")).toBe(false);
    });

    it("UT-R-HEAL-01-008 (HEAL_DISTRIBUTE): distribution EVEN splits one total heal amount across every target of the same EffectAction in the step", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const ally = unit("ALLY_2", "ALLY", { currentHp: 10 });
      const heal = healAction("ACT_HEAL_SHARED", {
        formula: { kind: "SKILL_POWER", power: 3 },
        overheal: "DISCARD",
        distribution: "EVEN",
      });
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            applications: [
              ...step.applications,
              {
                targetBattleUnitId: ally.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                includeDefeated: false,
                hits: [
                  {
                    targetBattleUnitId: ally.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: 1,
                  },
                ],
              },
            ],
          },
        ],
        targetUnitIds: [actor.battleUnitId, ally.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      // attack 20 * power 3 = 60 total, split evenly across the 2 targets = 30 each
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(40);
      expect(result.units.find((u) => u.battleUnitId === ally.battleUnitId)!.currentHp).toBe(40);
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(2);
      expect(healEvents[0]!.payload).toMatchObject({
        formulaResult: 60,
        distributionShareCount: 2,
        healAmount: 30,
      });
    });
  });

  describe("HEAL_DISTRIBUTE denominator (PRレビュー[P2] PR #256)", () => {
    it("UT-R-HEAL-01-011 (BOUNDARY): a target that is already defeated when the distributing HEAL starts is excluded from the share count, so the surviving targets still receive the whole total", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      // This ally is defeated before the step resolves (the same state a PS
      // chain triggered by EffectStepStarting would leave behind), so the HEAL
      // never applies to it and it must not consume a share of the total.
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_SHARED"),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          formula: { kind: "SKILL_POWER", power: 3 },
          overheal: "DISCARD",
          distribution: "EVEN",
        },
      };
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            applications: [
              ...step.applications,
              {
                targetBattleUnitId: deadAlly.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                includeDefeated: false,
                hits: [
                  {
                    targetBattleUnitId: deadAlly.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: 1,
                  },
                ],
              },
            ],
          },
        ],
        targetUnitIds: [actor.battleUnitId, deadAlly.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      // attack 20 * power 3 = 60 total. Only one target actually receives the
      // heal, so it gets the whole 60 — not 30 with the other half lost.
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(70);
      expect(result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentHp).toBe(0);
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(1);
      expect(healEvents[0]!.payload).toMatchObject({
        formulaResult: 60,
        distributionShareCount: 1,
        healAmount: 60,
      });
    });
  });

  describe("HEAL_DISTRIBUTE denominator with includeDefeated (再レビュー[P2] PR #256)", () => {
    it("UT-R-HEAL-01-012 (BOUNDARY): a defeated target selected with includeDefeated is still excluded from the share count, because R-HEAL-01 never heals it", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const deadAlly = unit("ALLY_DEAD", "ALLY", { currentHp: 0 });
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_SHARED"),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          formula: { kind: "SKILL_POWER", power: 3 },
          overheal: "DISCARD",
          distribution: "EVEN",
        },
      };
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            applications: [
              ...step.applications,
              {
                targetBattleUnitId: deadAlly.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                // The selector explicitly admits defeated units, but a HEAL
                // still cannot heal them (no revival rule in R-HEAL-01).
                includeDefeated: true,
                hits: [
                  {
                    targetBattleUnitId: deadAlly.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: 1,
                  },
                ],
              },
            ],
          },
        ],
        targetUnitIds: [actor.battleUnitId, deadAlly.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, deadAlly], context);

      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(70);
      expect(result.units.find((u) => u.battleUnitId === deadAlly.battleUnitId)!.currentHp).toBe(0);
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(1);
      expect(healEvents[0]!.payload).toMatchObject({
        distributionShareCount: 1,
        healAmount: 60,
      });
    });

    it("UT-R-HEAL-01-017 (PRレビュー[P2] PR #282): a step that references the same distributing HEAL twice splits one total per reference, so each target is healed once per reference", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
      const ally = unit("ALLY_2", "ALLY", { currentHp: 10 });
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_SHARED"),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          formula: { kind: "SKILL_POWER", power: 3 },
          overheal: "DISCARD",
          distribution: "EVEN",
        },
      };
      const effectActions = new Map([[heal.effectActionDefinitionId, heal]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const step = singleActionStep(0, true, actor.battleUnitId, heal.effectActionDefinitionId);
      if (step.planKind !== "ACTION_PLAN") {
        throw new Error("singleActionStep must produce an ACTION_PLAN");
      }
      const references = [
        { effectActionDefinitionId: heal.effectActionDefinitionId },
        { effectActionDefinitionId: heal.effectActionDefinitionId },
      ];
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          {
            ...step,
            actions: references,
            // `buildApplications`と同じ「対象ごとに`actions`を定義順で並べる」順序。
            applications: [actor, ally].flatMap((target) =>
              references.map((_, index) => ({
                targetBattleUnitId: target.battleUnitId,
                effectActionDefinitionId: heal.effectActionDefinitionId,
                includeDefeated: false,
                hits: [
                  {
                    targetBattleUnitId: target.battleUnitId,
                    effectActionDefinitionId: heal.effectActionDefinitionId,
                    hitIndex: index + 1,
                  },
                ],
              })),
            ),
          },
        ],
        targetUnitIds: [actor.battleUnitId, ally.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, ally], context);

      // attack 20 * power 3 = 60 を参照ごとに2対象へ等分（各30）。対象は30を2回
      // 受け取り10 + 60 = 70になる。4 applicationを1つの分配として数えると
      // 各回15、合計40にしかならない。
      for (const target of [actor, ally]) {
        expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(
          70,
        );
      }
      const healEvents = recorder.getEvents().filter((e) => e.eventType === "HealApplied");
      expect(healEvents).toHaveLength(4);
      for (const event of healEvents) {
        expect(event.payload).toMatchObject({ distributionShareCount: 2, healAmount: 30 });
      }
    });

    it("UT-R-SKL-08-020 (full stack, G-10/RES-003A Issue #257): a HEAL referencing SUM_DAMAGE_RECEIVED reads every DAMAGE result this EffectSequence inflicted on the healer itself — neither the healer's larger dealt sum nor its single most recent received result", () => {
      // 1ヒットあたり attack(20) - defense(10) = 10。
      // step0: 敵へ10（actorのdealt累計だけが増える）
      // step1/step2: 自傷10ずつ（actorのreceived累計が20、dealt累計は合計30になる）
      // step3: SUM_DAMAGE_RECEIVED(=20) × 1.0 を回復する。
      // dealt累計30・直前received 10のどちらとも異なる値になるため、この1つの
      // 期待値が「対象側への累積」と「Formulaへの配線」を同時に固定する。
      const actor = unit("ACTOR", "ALLY", { currentHp: 60 });
      const enemy = unit("ENEMY", "ENEMY");
      const attack = damageAction("ACT_ATTACK_ENEMY");
      const selfDamage = damageAction("ACT_SELF_DAMAGE");
      const heal: EffectActionDefinition = {
        kind: "HEAL",
        effectActionDefinitionId: createEffectActionDefinitionId("ACT_HEAL_BY_RECEIVED"),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload: {
          formula: { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "SUM_DAMAGE_RECEIVED", ratio: 1 },
          overheal: "DISCARD",
          distribution: "NONE",
        },
      };
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
        [selfDamage.effectActionDefinitionId, selfDamage],
        [heal.effectActionDefinitionId, heal],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const damageResults: DamageResultRegistry = new Map();
      const context = {
        ...contextFor(actor, effectActions, recorder, rootEventId),
        damageResults,
      };
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [
          singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId),
          singleActionStep(1, true, actor.battleUnitId, selfDamage.effectActionDefinitionId),
          singleActionStep(2, true, actor.battleUnitId, selfDamage.effectActionDefinitionId),
          singleActionStep(3, true, actor.battleUnitId, heal.effectActionDefinitionId),
        ],
        targetUnitIds: [enemy.battleUnitId, actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      // 60 - 10 - 10 (自傷2回) + 20 (SUM_DAMAGE_RECEIVED回復) = 60。
      expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(60);
      const healApplied = recorder.getEvents().find((e) => e.eventType === "HealApplied")!;
      expect(healApplied.payload).toMatchObject({
        effectActionDefinitionId: heal.effectActionDefinitionId,
        targetUnitId: actor.battleUnitId,
        formulaResult: 20,
        healAmount: 20,
        appliedAmount: 20,
      });
      // 実executorが与ダメージ側と被ダメージ側を同じEffectSequence解決へ
      // 独立に累積していることを、registry側からも固定する。
      const actorEntry = damageResults.get(actor.battleUnitId);
      expect(actorEntry?.sumDamageReceived?.get(context.skillUseId)).toBe(20);
      expect(actorEntry?.sumDamageDealt?.get(context.skillUseId)).toBe(30);
      expect(actorEntry?.lastDamageReceived).toBe(10);
    });
  });

  describe("APPLY_RESOURCE_GAIN_MOD (G-05, M7-002 Issue #185, RESOURCE_GAIN_MOD full-stack wiring)", () => {
    function resourceGainModAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "APPLY_RESOURCE_GAIN_MOD" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "APPLY_RESOURCE_GAIN_MOD",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    it("UT-R-ACT-04-013 (full stack): a self-targeted APPLY_RESOURCE_GAIN_MOD(EX_GAUGE, +50%) grants an AppliedEffect with the evaluated rateDelta as magnitude, through the real effect-action-group-resolver.ts wiring", () => {
      const actor = unit("ACTOR", "ALLY");
      const buff = resourceGainModAction("ACT_EX_GAIN_BUFF", {
        resource: "EX_GAUGE",
        rateDelta: { kind: "CONSTANT", value: 0.5 },
        stacking: { mode: "STACKABLE" },
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      });
      const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, buff.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.appliedEffects).toHaveLength(1);
      expect(updatedActor.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: buff.effectActionDefinitionId,
        magnitude: 0.5,
        duplicate: true,
      });
      expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
    });
  });

  describe("MODIFY_RESOURCE_CAPACITY (G-09, M7-002A Issue #255, CAP_RESOURCE_CAPACITY_MOD full-stack wiring)", () => {
    function capacityAction(
      id: string,
      payload: Extract<EffectActionDefinition, { kind: "MODIFY_RESOURCE_CAPACITY" }>["payload"],
    ): EffectActionDefinition {
      return {
        kind: "MODIFY_RESOURCE_CAPACITY",
        effectActionDefinitionId: createEffectActionDefinitionId(id),
        requiredCapabilities: [],
        metadata: { tags: [] },
        payload,
      };
    }

    // `ACT_FLUTE_VAMPIRE_PS1_MAX_AP_UP`と同じ形（`resource: AP` / `operation: ADD` /
    // 戦闘中恒久＝`timeLimit: {unit: BATTLE, count: 1}`）。
    const MAX_AP_UP: Extract<
      EffectActionDefinition,
      { kind: "MODIFY_RESOURCE_CAPACITY" }
    >["payload"] = {
      resource: "AP",
      operation: "ADD",
      formula: { kind: "CONSTANT", value: 1 },
      duration: {
        dispellable: false,
        linkedEffectGroupId: null,
        timeLimit: { unit: "BATTLE", count: 1 },
      },
    };

    it("UT-R-ACTN-03-015 (full stack): a self-targeted MODIFY_RESOURCE_CAPACITY(AP, ADD +1) grants an AppliedEffect and raises maximumAp through the real resolver wiring, emitting ResourceCapacityChanged", () => {
      const actor = unit("ACTOR", "ALLY");
      const buff = capacityAction("ACT_MAX_AP_UP", MAX_AP_UP);
      const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, buff.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.appliedEffects).toHaveLength(1);
      expect(updatedActor.appliedEffects[0]).toMatchObject({
        effectActionDefinitionId: buff.effectActionDefinitionId,
        magnitude: 1,
        duplicate: true,
      });
      expect(updatedActor.maximumAp).toBe(actor.baseMaximumAp + 1);
      expect(updatedActor.baseMaximumAp).toBe(actor.baseMaximumAp);
      // 上限が上がっただけでは現在値は追随しない（R-ACT-04）。
      expect(updatedActor.currentAp).toBe(actor.currentAp);
      const capacityEvents = recorder
        .getEvents()
        .filter((e) => e.eventType === "ResourceCapacityChanged");
      expect(capacityEvents).toHaveLength(1);
      expect(capacityEvents[0]!.payload).toMatchObject({
        battleUnitId: actor.battleUnitId,
        resource: "AP",
        before: actor.baseMaximumAp,
        after: actor.baseMaximumAp + 1,
        reason: "EFFECT_APPLIED",
      });
      expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
    });

    it("UT-R-ACTN-03-016 (negative): a blocking EFFECT_IMMUNITY rejects the capacity change, leaving maximumAp at the base", () => {
      const buff = capacityAction("ACT_MAX_AP_UP", MAX_AP_UP);
      const immunityDefinitionId = createEffectActionDefinitionId("ACT_BUFF_IMMUNITY");
      const immunity: AppliedEffect = {
        effectInstanceId: createEffectInstanceId("ei-immunity-capacity"),
        effectActionDefinitionId: immunityDefinitionId,
        kindKey: effectKindKeyFromDefinitionId(immunityDefinitionId),
        duplicate: true,
        sourceId: createBattleUnitId("ACTOR"),
        targetId: createBattleUnitId("ACTOR"),
        magnitude: 0,
        categories: ["BUFF"],
        immunity: { categories: ["BUFF"], maxBlocks: null, blockedCount: 0 },
        duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
        appliedTurnNumber: 1,
      };
      const actor = unit("ACTOR", "ALLY", { appliedEffects: [immunity] });
      const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        stealthConsumptions: [],
        steps: [singleActionStep(0, true, actor.battleUnitId, buff.effectActionDefinitionId)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: new Map(),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const updatedActor = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
      expect(updatedActor.maximumAp).toBe(actor.baseMaximumAp);
      expect(recorder.getEvents().some((e) => e.eventType === "EffectApplicationRejected")).toBe(
        true,
      );
      expect(
        recorder.getEvents().filter((e) => e.eventType === "ResourceCapacityChanged"),
      ).toHaveLength(0);
    });
  });
});

describe("resolveEffectSequencePlan: R-TGT-08 Stealth consumption (TGT-004, Issue #167, Phase 2: AppliedEffect-based)", () => {
  it("UT-SKILL-RESOLUTION-SERVICE-013: a plan.stealthConsumptions entry is applied before the first step, expiring the AppliedEffect and emitting EffectExpired(reason:CONSUMPTION)", () => {
    const actor = unit("ACTOR", "ALLY");
    const stealthDefinitionId = createEffectActionDefinitionId("ACT_STEALTH_TEST");
    const stealthInstance: AppliedEffect = {
      effectInstanceId: createEffectInstanceId("ei-stealth-1"),
      effectActionDefinitionId: stealthDefinitionId,
      kindKey: effectKindKeyFromDefinitionId(stealthDefinitionId),
      duplicate: true,
      sourceId: createBattleUnitId("HOLDER"),
      targetId: createBattleUnitId("HOLDER"),
      magnitude: 0,
      categories: ["BUFF"],
      statusKind: "STEALTH",
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
    const holder = unit("HOLDER", "ENEMY", { appliedEffects: [stealthInstance] });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [
        { battleUnitId: holder.battleUnitId, effectInstanceId: stealthInstance.effectInstanceId },
      ],
      steps: [singleActionStep(0, true, holder.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [holder.battleUnitId],
      resolvedBindings: new Map(),
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor, holder], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted[0]).toBe("EffectExpired");
    expect(recorder.getEvents()[before]!.payload).toMatchObject({
      effectInstanceId: stealthInstance.effectInstanceId,
      reason: "CONSUMPTION",
    });
    const nextHolder = result.units.find((u) => u.battleUnitId === holder.battleUnitId)!;
    expect(nextHolder.appliedEffects).toHaveLength(0);
  });

  it("UT-SKILL-RESOLUTION-SERVICE-014: an empty plan.stealthConsumptions emits no EffectExpired", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const before = recorder.getEvents().length;
    applyEffectActionGroups(plan, [actor, enemy], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).not.toContain("EffectExpired");
  });

  // --- M7-001 (Issue #181): REMOVE_EFFECTS (R-EFF-02) real lifecycle wiring ---

  function removeEffectsAction(
    id: string,
    payload: Extract<EffectActionDefinition, { kind: "REMOVE_EFFECTS" }>["payload"],
  ): EffectActionDefinition {
    return {
      kind: "REMOVE_EFFECTS",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload,
    };
  }

  function buffEffectOn(
    holder: BattleUnit,
    instanceId: string,
    definitionId: EffectActionDefinition["effectActionDefinitionId"],
    magnitude: number,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      categories: ["BUFF"],
      duplicate: true,
      sourceId: holder.battleUnitId,
      targetId: holder.battleUnitId,
      magnitude,
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 0,
    };
  }

  it("UT-R-EFF-02-020 (REMOVE_BUFF_CATEGORY, real lifecycle wiring): a REMOVE_EFFECTS BUFF ACTION step clears a pre-existing buff AppliedEffect, emits EffectRemoved(reason REMOVED)+CombatStatChanged(EFFECT_REMOVED), and reverts the stat", () => {
    const actor = unit("ACTOR", "ALLY");
    const buffDef = statModAction("ACT_ATK_UP");
    // Target already carries the buff and its combatStats reflect it (+20 attack).
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        buffEffectOn(unit("ENEMY", "ENEMY"), "existing-buff", buffDef.effectActionDefinitionId, 20),
      ],
      combatStats: { ...unit("ENEMY", "ENEMY").combatStats, attack: 40 },
    });
    const remove = removeEffectsAction("ACT_STRIP_BUFF", { categories: ["BUFF"] });
    const effectActions = new Map([
      [buffDef.effectActionDefinitionId, buffDef],
      [remove.effectActionDefinitionId, remove],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, remove.effectActionDefinitionId)],
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
      "EffectRemoved",
      "CombatStatChanged",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);

    const strippedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(strippedTarget.appliedEffects).toHaveLength(0);
    expect(strippedTarget.combatStats.attack).toBe(20);

    const removed = recorder.getEvents().find((e) => e.eventType === "EffectRemoved") as Extract<
      BattleDomainEvent,
      { eventType: "EffectRemoved" }
    >;
    expect(removed.payload).toMatchObject({
      effectInstanceId: createEffectInstanceId("existing-buff"),
      battleUnitId: enemy.battleUnitId,
      reason: "REMOVED",
      cascaded: false,
    });
    const statChanged = recorder
      .getEvents()
      .find((e) => e.eventType === "CombatStatChanged") as Extract<
      BattleDomainEvent,
      { eventType: "CombatStatChanged" }
    >;
    expect(statChanged.payload).toMatchObject({ reason: "EFFECT_REMOVED", before: 40, after: 20 });
    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
  });

  it("UT-R-EFF-02-021 (REMOVE_EFFECTS_COUNT_LIMIT, real lifecycle wiring): a REMOVE_EFFECTS DEBUFF with maxRemovals=2 removes only the two oldest debuffs", () => {
    const actor = unit("ACTOR", "ALLY");
    const debuffDef = statModAction("ACT_ATK_DOWN");
    const debuffs = [1, 2, 3].map((n) =>
      buffEffectOn(unit("ENEMY", "ENEMY"), `debuff-${n}`, debuffDef.effectActionDefinitionId, -5),
    );
    const enemy = unit("ENEMY", "ENEMY", { appliedEffects: debuffs });
    const remove = removeEffectsAction("ACT_CLEANSE_2", {
      categories: ["DEBUFF"],
      maxRemovals: 2,
    });
    const effectActions = new Map([
      [debuffDef.effectActionDefinitionId, debuffDef],
      [remove.effectActionDefinitionId, remove],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, remove.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);
    const strippedTarget = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(strippedTarget.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      createEffectInstanceId("debuff-3"),
    ]);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectRemoved")).toHaveLength(2);
  });

  // --- M7-001A (Issue #242, REMOVE_EFFECTS_CATEGORY_GAP): SHIELD/SUBUNIT category removal ---

  function shieldAction(id: string, shieldType: "PHYSICAL" | "EN" | null): EffectActionDefinition {
    return {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: 100 },
        ...(shieldType !== null ? { shieldType } : {}),
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    };
  }

  function subUnitAction(id: string): EffectActionDefinition {
    return {
      kind: "APPLY_SUBUNIT",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        durability: { formula: { kind: "CONSTANT", value: 80 } },
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0.1,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
        },
        duration: { dispellable: true, linkedEffectGroupId: null },
      },
    };
  }

  function shieldEffectOn(
    holder: BattleUnit,
    instanceId: string,
    definitionId: EffectActionDefinition["effectActionDefinitionId"],
    remaining: number,
    shieldType: "PHYSICAL" | "EN" | null = null,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      categories: ["SHIELD"],
      duplicate: true,
      sourceId: holder.battleUnitId,
      targetId: holder.battleUnitId,
      magnitude: remaining,
      shield: { shieldType, remaining },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 0,
    };
  }

  function subUnitEffectOn(
    holder: BattleUnit,
    instanceId: string,
    definitionId: EffectActionDefinition["effectActionDefinitionId"],
    durability: number,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      categories: ["SUBUNIT"],
      duplicate: true,
      sourceId: holder.battleUnitId,
      targetId: holder.battleUnitId,
      magnitude: durability,
      subUnit: {
        durability,
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0.1,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
        },
      },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: 100 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 0,
    };
  }

  it("UT-R-EFF-02-022 (M7-001A, Issue #242, REMOVE_EFFECTS_CATEGORY_GAP): a REMOVE_EFFECTS SHIELD ACTION step clears every shield-bearing AppliedEffect of the target (SKL_YUI_HEIR_EX), emptying all shield pools while leaving non-shield effects", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemyBase = unit("ENEMY", "ENEMY");
    const enShield = shieldAction("ACT_EN_SHIELD", "EN");
    const untypedShield = shieldAction("ACT_UNTYPED_SHIELD", null);
    const buffDef = statModAction("ACT_ATK_UP");
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        shieldEffectOn(enemyBase, "shield-en", enShield.effectActionDefinitionId, 120, "EN"),
        buffEffectOn(enemyBase, "kept-buff", buffDef.effectActionDefinitionId, 20),
        shieldEffectOn(enemyBase, "shield-untyped", untypedShield.effectActionDefinitionId, 60),
      ],
      combatStats: { ...enemyBase.combatStats, attack: 40 },
    });
    const remove = removeEffectsAction("ACT_STRIP_SHIELD", { categories: ["SHIELD"] });
    const effectActions = new Map([
      [enShield.effectActionDefinitionId, enShield],
      [untypedShield.effectActionDefinitionId, untypedShield],
      [buffDef.effectActionDefinitionId, buffDef],
      [remove.effectActionDefinitionId, remove],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, remove.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);
    const stripped = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;

    expect(stripped.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      createEffectInstanceId("kept-buff"),
    ]);
    expect(shieldPoolsOf(stripped.appliedEffects)).toEqual({
      physical: 0,
      energy: 0,
      untyped: 0,
    });
    const removed = recorder
      .getEvents()
      .filter((e) => e.eventType === "EffectRemoved")
      .map((e) => e.payload);
    expect(removed).toEqual([
      expect.objectContaining({
        effectInstanceId: createEffectInstanceId("shield-en"),
        reason: "REMOVED",
        cascaded: false,
      }),
      expect.objectContaining({
        effectInstanceId: createEffectInstanceId("shield-untyped"),
        reason: "REMOVED",
        cascaded: false,
      }),
    ]);
  });

  it("UT-R-EFF-02-023 (M7-001A, Issue #242, REMOVE_EFFECTS_CATEGORY_GAP): a REMOVE_EFFECTS [SHIELD, SUBUNIT] ACTION step on SELF clears both the shield pools and the sub-unit durability (SKL_OLGA_VETERAN_PS1)", () => {
    const actorBase = unit("ACTOR", "ALLY");
    const shieldDef = shieldAction("ACT_SELF_SHIELD", "PHYSICAL");
    const subUnitDef = subUnitAction("ACT_SELF_SUBUNIT");
    const buffDef = statModAction("ACT_ATK_UP");
    const actor = unit("ACTOR", "ALLY", {
      appliedEffects: [
        shieldEffectOn(
          actorBase,
          "self-shield",
          shieldDef.effectActionDefinitionId,
          90,
          "PHYSICAL",
        ),
        subUnitEffectOn(actorBase, "self-sub-1", subUnitDef.effectActionDefinitionId, 80),
        buffEffectOn(actorBase, "kept-buff", buffDef.effectActionDefinitionId, 20),
        subUnitEffectOn(actorBase, "self-sub-2", subUnitDef.effectActionDefinitionId, 80),
      ],
      combatStats: { ...actorBase.combatStats, attack: 40 },
    });
    const remove = removeEffectsAction("ACT_STRIP_SHIELD_SUBUNIT", {
      categories: ["SHIELD", "SUBUNIT"],
    });
    const effectActions = new Map([
      [shieldDef.effectActionDefinitionId, shieldDef],
      [subUnitDef.effectActionDefinitionId, subUnitDef],
      [buffDef.effectActionDefinitionId, buffDef],
      [remove.effectActionDefinitionId, remove],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, remove.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor], context);
    const stripped = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;

    expect(stripped.appliedEffects.map((e) => e.effectInstanceId)).toEqual([
      createEffectInstanceId("kept-buff"),
    ]);
    expect(shieldPoolsOf(stripped.appliedEffects)).toEqual({
      physical: 0,
      energy: 0,
      untyped: 0,
    });
    expect(subUnitDurabilityTotal(stripped.appliedEffects)).toBe(0);
    expect(
      recorder
        .getEvents()
        .filter((e) => e.eventType === "EffectRemoved")
        .map((e) => e.payload.effectInstanceId),
    ).toEqual([
      createEffectInstanceId("self-shield"),
      createEffectInstanceId("self-sub-1"),
      createEffectInstanceId("self-sub-2"),
    ]);
  });

  // --- M7-001B (Issue #243, EFFECT_IMMUNITY_STATUS_GRANULARITY): EFFECT_IMMUNITY (R-EFF-03) real lifecycle wiring ---

  function immunityAction(
    id: string,
    payload: Extract<EffectActionDefinition, { kind: "EFFECT_IMMUNITY" }>["payload"],
  ): EffectActionDefinition {
    return {
      kind: "EFFECT_IMMUNITY",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload,
    };
  }

  function immunityEffectOn(
    holder: BattleUnit,
    instanceId: string,
    definitionId: EffectActionDefinition["effectActionDefinitionId"],
    immunity: NonNullable<AppliedEffect["immunity"]>,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      sourceId: holder.battleUnitId,
      targetId: holder.battleUnitId,
      magnitude: 0,
      categories: ["BUFF"],
      immunity,
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 0,
    };
  }

  it("UT-R-EFF-03-011 (real lifecycle wiring): an EFFECT_IMMUNITY ACTION step grants an immunity-bearing AppliedEffect through the real Catalog -> EffectSequence -> AppliedEffect -> event pipeline", () => {
    const actor = unit("ACTOR", "ALLY");
    const immunity = immunityAction("ACT_STUN_IMMUNITY", {
      categories: ["STATUS"],
      statusKinds: ["STUN"],
      duration: {
        timeLimit: { unit: "ACTION", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      maxBlocks: null,
    });
    const effectActions = new Map([[immunity.effectActionDefinitionId, immunity]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, immunity.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "EffectApplied",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);

    const grantedTarget = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(grantedTarget.appliedEffects).toHaveLength(1);
    expect(grantedTarget.appliedEffects[0]!.immunity).toEqual({
      categories: ["STATUS"],
      statusKinds: ["STUN"],
      maxBlocks: null,
      blockedCount: 0,
    });

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
  });

  it("UT-R-EFF-03-018 (PR #245 review [P2] fix): a pre-existing SPECIFIC_EFFECT immunity targeting an EFFECT_IMMUNITY definition rejects granting that immunity instead of always succeeding", () => {
    const immunity = immunityAction("ACT_STUN_IMMUNITY", {
      categories: ["STATUS"],
      statusKinds: ["STUN"],
      duration: {
        timeLimit: { unit: "ACTION", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
      maxBlocks: null,
    });
    const blockerDefId = createEffectActionDefinitionId("ACT_ANTI_IMMUNITY_SEAL");
    const actor = unit("ACTOR", "ALLY", {
      appliedEffects: [
        immunityEffectOn(unit("ACTOR", "ALLY"), "existing-seal", blockerDefId, {
          categories: ["SPECIFIC_EFFECT"],
          effectActionDefinitionIds: [immunity.effectActionDefinitionId],
          maxBlocks: null,
          blockedCount: 0,
        }),
      ],
    });
    const effectActions = new Map([[immunity.effectActionDefinitionId, immunity]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, immunity.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const before = recorder.getEvents().length;
    const result = applyEffectActionGroups(plan, [actor], context);
    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);

    expect(emitted).toEqual([
      "EffectStepStarting",
      "EffectActionStarting",
      "EffectApplicationRejected",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);

    const target = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    // Only the pre-existing seal remains; the new STUN immunity was never granted.
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]!.effectActionDefinitionId).toBe(blockerDefId);
    expect(target.appliedEffects[0]!.immunity?.blockedCount).toBe(1);

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("REJECTED");
  });

  it("UT-R-EFF-03-012: an APPLY_STAT_MOD DEBUFF is rejected by a pre-existing DEBUFF-category immunity, emitting EffectApplicationRejected (resultKind REJECTED) instead of EffectApplied", () => {
    const actor = unit("ACTOR", "ALLY");
    const debuff: EffectActionDefinition = {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_ATK_DOWN"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value: -10 },
        stacking: { mode: "STACKABLE", max: null },
        duration: {
          timeLimit: { unit: "TURN", count: 2 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const immunityDefId = createEffectActionDefinitionId("ACT_DEBUFF_IMMUNITY");
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        immunityEffectOn(unit("ENEMY", "ENEMY"), "existing-immunity", immunityDefId, {
          categories: ["DEBUFF"],
          maxBlocks: null,
          blockedCount: 0,
        }),
      ],
    });
    const effectActions = new Map([[debuff.effectActionDefinitionId, debuff]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, debuff.effectActionDefinitionId)],
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
      "EffectApplicationRejected",
      "EffectActionCompleted",
      "EffectStepCompleted",
    ]);
    expectCompleted(result, 1);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(1);
    expect(target.appliedEffects[0]!.immunity?.blockedCount).toBe(1);

    const rejected = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectApplicationRejected") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplicationRejected" }
    >;
    expect(rejected.payload).toMatchObject({
      battleUnitId: enemy.battleUnitId,
      effectActionDefinitionId: debuff.effectActionDefinitionId,
      sourceUnitId: actor.battleUnitId,
      blockingEffectInstanceId: createEffectInstanceId("existing-immunity"),
      reason: "IMMUNITY",
    });

    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("REJECTED");
  });

  it("UT-R-EFF-03-013 (EFFECT_IMMUNITY_STATUS_GRANULARITY): a STATUS immunity scoped to statusKinds STUN rejects an APPLY_STATUS(STUN) grant before reaching the STEALTH-only resolver guard", () => {
    const actor = unit("ACTOR", "ALLY");
    const stun: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const immunityDefId = createEffectActionDefinitionId("ACT_STUN_IMMUNITY");
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        immunityEffectOn(unit("ENEMY", "ENEMY"), "existing-immunity", immunityDefId, {
          categories: ["STATUS"],
          statusKinds: ["STUN"],
          maxBlocks: null,
          blockedCount: 0,
        }),
      ],
    });
    const effectActions = new Map([[stun.effectActionDefinitionId, stun]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    expect(() => applyEffectActionGroups(plan, [actor, enemy], context)).not.toThrow();

    const rejected = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectApplicationRejected") as Extract<
      BattleDomainEvent,
      { eventType: "EffectApplicationRejected" }
    >;
    expect(rejected.payload).toMatchObject({
      battleUnitId: enemy.battleUnitId,
      statusKind: "STUN",
      reason: "IMMUNITY",
    });
    const target = enemy;
    expect(target.appliedEffects.some((e) => e.statusKind === "STUN")).toBe(false);
  });

  it("UT-R-EFF-03-014 (EFFECT_IMMUNITY_STATUS_GRANULARITY): a STATUS immunity scoped to statusKinds FREEZE does NOT block a STUN attempt, which grants normally", () => {
    const actor = unit("ACTOR", "ALLY");
    const stun: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const immunityDefId = createEffectActionDefinitionId("ACT_FREEZE_IMMUNITY");
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        immunityEffectOn(unit("ENEMY", "ENEMY"), "existing-immunity", immunityDefId, {
          categories: ["STATUS"],
          statusKinds: ["FREEZE"],
          maxBlocks: null,
          blockedCount: 0,
        }),
      ],
    });
    const effectActions = new Map([[stun.effectActionDefinitionId, stun]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    // The pre-existing FREEZE-only immunity instance stays untouched, plus the newly granted STUN.
    expect(target.appliedEffects).toHaveLength(2);
    expect(target.appliedEffects.some((effect) => effect.statusKind === "STUN")).toBe(true);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplied")).toBe(true);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplicationRejected")).toBe(
      false,
    );
  });

  it("UT-R-EFF-03-015: a MARKER-category immunity rejects an APPLY_MARKER grant", () => {
    const actor = unit("ACTOR", "ALLY");
    const markerId = createMarkerId("MARKER_TEST");
    const mark = markerAction("ACT_MARK", markerId);
    const immunityDefId = createEffectActionDefinitionId("ACT_MARKER_IMMUNITY");
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        immunityEffectOn(unit("ENEMY", "ENEMY"), "existing-immunity", immunityDefId, {
          categories: ["MARKER"],
          maxBlocks: null,
          blockedCount: 0,
        }),
      ],
    });
    const effectActions = new Map([[mark.effectActionDefinitionId, mark]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, mark.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.markerStates).toHaveLength(0);
    expect(recorder.getEvents().some((e) => e.eventType === "EffectApplicationRejected")).toBe(
      true,
    );
    expect(recorder.getEvents().some((e) => e.eventType === "MarkerApplied")).toBe(false);
  });

  it("UT-R-EFF-07-014 (R-EFF-07 通知粒度, PR #280 再々レビュー[P1]): EffectConsumptionChanged reaches the PS/Memory chain before the next hit, even when the consumption does not reach 0 (no expiry step)", () => {
    const actor = unit("ACTOR", "ALLY");
    const attack = damageAction("ACT_TWO_HIT", 2);
    const consumptionDefId = createEffectActionDefinitionId("ACT_INCOMING_HIT_BUFF");
    // 残回数3・2ヒットなので、どちらのヒットでも0にならない = 失効stepが存在しない。
    // 以前は`EffectConsumptionChanged`をstepとしてyieldしていなかったため、
    // この経路では一度もPS/Memory連鎖へ届かなかった。
    const enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("incoming-hit-buff"),
          effectActionDefinitionId: consumptionDefId,
          kindKey: effectKindKeyFromDefinitionId(consumptionDefId),
          duplicate: true,
          sourceId: createBattleUnitId("ENEMY"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["BUFF"],
          duration: {
            definition: {
              dispellable: true,
              linkedEffectGroupId: null,
              consumption: { kind: "INCOMING_HIT", maxCount: 3 },
            },
            consumptionRemaining: 3,
          },
          appliedTurnNumber: 0,
        },
      ],
    });
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();
    const observed: string[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observed.push(event.eventType);
      return units;
    });
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        {
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
          applications: [
            {
              targetBattleUnitId: enemy.battleUnitId,
              effectActionDefinitionId: attack.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetBattleUnitId: enemy.battleUnitId,
                  effectActionDefinitionId: attack.effectActionDefinitionId,
                  hitIndex: 1,
                },
                {
                  targetBattleUnitId: enemy.battleUnitId,
                  effectActionDefinitionId: attack.effectActionDefinitionId,
                  hitIndex: 2,
                },
              ],
            },
          ],
        },
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects[0]!.duration.consumptionRemaining).toBe(1);

    // 2件の`EffectConsumptionChanged`が、それぞれのヒットの`DamageApplied`の後・
    // 次のヒットの`DamageApplied`より前にPS/Memory連鎖へ渡っている。
    const consumptionIndexes = observed.flatMap((eventType, index) =>
      eventType === "EffectConsumptionChanged" ? [index] : [],
    );
    const damageIndexes = observed.flatMap((eventType, index) =>
      eventType === "DamageApplied" ? [index] : [],
    );
    expect(consumptionIndexes).toHaveLength(2);
    expect(damageIndexes).toHaveLength(2);
    expect(consumptionIndexes[0]).toBeGreaterThan(damageIndexes[0]!);
    expect(consumptionIndexes[0]).toBeLessThan(damageIndexes[1]!);
    expect(consumptionIndexes[1]).toBeGreaterThan(damageIndexes[1]!);
  });

  it("UT-R-EFF-07-015 (R-EFF-07 通知粒度, PR #280 再々々レビュー[P1]): consumes matching instances one at a time — the first EffectConsumptionChanged watcher still sees the second instance untouched, and removing it there skips its consumption instead of crashing", () => {
    const actor = unit("ACTOR", "ALLY");
    const attack = damageAction("ACT_ONE_HIT", 1);
    const consumptionDefId = createEffectActionDefinitionId("ACT_INCOMING_HIT_BUFF");
    const consumptionEffect = (id: string): AppliedEffect => ({
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: consumptionDefId,
      kindKey: effectKindKeyFromDefinitionId(consumptionDefId),
      duplicate: true,
      sourceId: createBattleUnitId("ENEMY"),
      targetId: createBattleUnitId("ENEMY"),
      magnitude: 0,
      categories: ["BUFF"],
      duration: {
        definition: {
          dispellable: true,
          linkedEffectGroupId: null,
          consumption: { kind: "INCOMING_HIT" as const, maxCount: 3 },
        },
        consumptionRemaining: 3,
      },
      appliedTurnNumber: 0,
    });
    const first = consumptionEffect("incoming-hit-first");
    const second = consumptionEffect("incoming-hit-second");
    const enemy = unit("ENEMY", "ENEMY", { appliedEffects: [first, second] });
    const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
    const { recorder, rootEventId } = seedRecorder();

    let secondRemainingAtFirstEvent: number | undefined;
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      if (event.eventType !== "EffectConsumptionChanged") {
        return units;
      }
      const holder = units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
      secondRemainingAtFirstEvent = holder.appliedEffects.find(
        (effect) => effect.effectInstanceId === second.effectInstanceId,
      )?.duration.consumptionRemaining;
      // 1件目の消費を契機に2件目を解除するPS連鎖を模す。
      return units.map((u) =>
        u.battleUnitId === enemy.battleUnitId
          ? {
              ...u,
              appliedEffects: u.appliedEffects.filter(
                (effect) => effect.effectInstanceId !== second.effectInstanceId,
              ),
            }
          : u,
      );
    });
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    // 1件目のイベント観測時、2件目はまだ減算されていない（state変更もstep単位）。
    expect(secondRemainingAtFirstEvent).toBe(3);
    // 連鎖で消えた2件目の消費はskipされ、イベントも発行されない。
    const consumptionEvents = recorder
      .getEvents()
      .filter((e) => e.eventType === "EffectConsumptionChanged");
    expect(consumptionEvents).toHaveLength(1);
    expect(consumptionEvents[0]!.payload).toMatchObject({
      effectInstanceId: first.effectInstanceId,
      before: 3,
      after: 2,
    });
    const target = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(target.appliedEffects.map((effect) => effect.effectInstanceId)).toEqual([
      first.effectInstanceId,
    ]);
    expect(target.appliedEffects[0]!.duration.consumptionRemaining).toBe(2);
  });

  it("UT-R-EFF-03-016 (maxBlocks + STATUS_BLOCKED self-consumption, production shape ACT_SENKA_CHRISTMAS_PS1_STUN_IMMUNITY): a STATUS immunity with maxBlocks=1 and duration.consumption STATUS_BLOCKED blocks a STUN attempt exactly once, then consumes/expires itself so a second attempt grants the STUN", () => {
    const actor = unit("ACTOR", "ALLY");
    const stun: EffectActionDefinition = {
      kind: "APPLY_STATUS",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_STUN"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        status: "STUN",
        duration: {
          timeLimit: { unit: "ACTION", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const immunityDefId = createEffectActionDefinitionId("ACT_STATUS_IMMUNITY_LIMITED");
    let enemy = unit("ENEMY", "ENEMY", {
      appliedEffects: [
        {
          effectInstanceId: createEffectInstanceId("existing-immunity"),
          effectActionDefinitionId: immunityDefId,
          kindKey: effectKindKeyFromDefinitionId(immunityDefId),
          duplicate: true,
          sourceId: createBattleUnitId("ENEMY"),
          targetId: createBattleUnitId("ENEMY"),
          magnitude: 0,
          categories: ["BUFF"],
          immunity: { categories: ["STATUS"], maxBlocks: 1, blockedCount: 0 },
          duration: {
            definition: {
              dispellable: true,
              linkedEffectGroupId: null,
              consumption: { kind: "STATUS_BLOCKED", maxCount: 1 },
            },
            consumptionRemaining: 1,
          },
          appliedTurnNumber: 0,
        },
      ],
    });
    const effectActions = new Map([[stun.effectActionDefinitionId, stun]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const firstAttemptPlan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const firstResult = applyEffectActionGroups(firstAttemptPlan, [actor, enemy], context);
    const emittedFirst = recorder.getEvents().map((e) => e.eventType);
    expect(emittedFirst).toContain("EffectApplicationRejected");
    expect(emittedFirst).toContain("EffectConsumptionChanged");
    expect(emittedFirst).toContain("EffectExpired");

    enemy = firstResult.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    // The immunity itself is now gone (consumed to 0 -> expired).
    expect(enemy.appliedEffects).toHaveLength(0);

    const secondAttemptPlan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, enemy.battleUnitId, stun.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };
    // The immunity is gone, so the second STUN attempt grants normally.
    const secondResult = applyEffectActionGroups(secondAttemptPlan, [actor, enemy], context);
    const secondTarget = secondResult.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(secondTarget.appliedEffects).toHaveLength(1);
    expect(secondTarget.appliedEffects[0]).toMatchObject({ statusKind: "STUN" });
  });
});

/**
 * M7-012（Issue #266、R-EFF-05／`STACK_LIMIT_ON_STAT_MOD`）: `APPLY_STAT_MOD`の
 * 重複なし（`NON_STACKABLE`）表現と重複上限（`stacking.max`）の実ライフサイクル配線。
 * それまで`stacking.mode`は`STACKABLE`しかCatalogスキーマに存在せず、resolverも
 * `duplicate: true`固定で付与していたため、重複なし経路・最強選択・
 * `EffectiveEffectChanged`のいずれにも実ライフサイクルから到達できなかった。
 */
describe("applyEffectActionGroups: R-EFF-05 stacking mode and stack limit (M7-012, Issue #266)", () => {
  function ratioStatMod(
    id: string,
    value: number,
    stacking: { mode: "STACKABLE" | "NON_STACKABLE"; max: number | null },
  ): EffectActionDefinition {
    return {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "FIXED",
        formula: { kind: "CONSTANT", value },
        stacking,
        duration: {
          timeLimit: { unit: "BATTLE", count: 1 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  /**
   * `recalculateCombatStats`は`context.definitions.effectActions`から各
   * `AppliedEffect`の定義を引くため、既に付与済みの効果の定義も併せて渡す
   * （`known`）。渡さないと過去に付与した効果がCombatStat合成から黙って
   * 落ちてしまい、テスト自身の前提が崩れる。
   */
  function applyOnce(
    definition: EffectActionDefinition,
    units: readonly BattleUnit[],
    actor: BattleUnit,
    recorder: EventRecorder,
    rootEventId: string,
    known: readonly EffectActionDefinition[] = [],
  ): EffectActionGroupsResult {
    const effectActions = new Map(
      [...known, definition].map((d) => [d.effectActionDefinitionId, d]),
    );
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, definition.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };
    return applyEffectActionGroups(
      plan,
      units,
      contextFor(actor, effectActions, recorder, rootEventId),
    );
  }

  it("UT-R-EFF-05-017 (real lifecycle wiring): a NON_STACKABLE APPLY_STAT_MOD is granted with duplicate: false, so only the strongest instance feeds CombatStat", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    const weak = ratioStatMod("ACT_ATK_UP_WEAK", 20, { mode: "NON_STACKABLE", max: null });

    const first = applyOnce(weak, [actor], actor, recorder, rootEventId);
    const afterFirst = first.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterFirst.appliedEffects).toHaveLength(1);
    expect(afterFirst.appliedEffects[0]!.duplicate).toBe(false);
    expect(afterFirst.combatStats.attack).toBe(actor.baseCombatStats.attack + 20);

    // 同じ`EffectKindKey`の2件目（同じ効果量）は保持されるが（R-EFF-05第2項
    // 「重複なし効果も、既存効果を上書きせず個別に保持する」）、計算へ採用される
    // のは最強1件だけなので攻撃力は増えない — `STACKABLE`なら+40になる。
    const second = applyOnce(weak, first.units, actor, recorder, rootEventId);
    const afterSecond = second.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterSecond.appliedEffects).toHaveLength(2);
    expect(afterSecond.combatStats.attack).toBe(actor.baseCombatStats.attack + 20);
  });

  it("UT-R-EFF-05-018 (real lifecycle wiring): a stronger NON_STACKABLE instance displaces the previous winner, emitting EffectiveEffectChanged before CombatStatChanged", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    // 同じ`EffectKindKey`（＝同じ`EffectActionDefinitionId`）でなければ同種
    // グループにならないため、効果量だけをFormulaで差し替えた同一IDの定義を使う。
    const weak = ratioStatMod("ACT_ATK_UP", 20, { mode: "NON_STACKABLE", max: null });
    const strong = ratioStatMod("ACT_ATK_UP", 50, { mode: "NON_STACKABLE", max: null });

    const first = applyOnce(weak, [actor], actor, recorder, rootEventId);
    const before = recorder.getEvents().length;
    const second = applyOnce(strong, first.units, actor, recorder, rootEventId);

    const emitted = recorder
      .getEvents()
      .slice(before)
      .map((e) => e.eventType);
    expect(emitted).toContain("EffectiveEffectChanged");
    expect(emitted.indexOf("EffectiveEffectChanged")).toBeLessThan(
      emitted.indexOf("CombatStatChanged"),
    );

    const changed = recorder
      .getEvents()
      .slice(before)
      .find((e) => e.eventType === "EffectiveEffectChanged") as Extract<
      BattleDomainEvent,
      { eventType: "EffectiveEffectChanged" }
    >;
    const winner = first.units.find((u) => u.battleUnitId === actor.battleUnitId)!
      .appliedEffects[0]!.effectInstanceId;
    expect(changed.payload).toMatchObject({
      battleUnitId: actor.battleUnitId,
      kindKey: "ACT_ATK_UP",
      before: winner,
    });

    const afterSecond = second.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterSecond.combatStats.attack).toBe(actor.baseCombatStats.attack + 50);
  });

  it("UT-R-EFF-05-019 (real lifecycle wiring, 重複上限): a grant at stacking.max adds no instance and completes as SKIPPED without EffectApplied", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    const capped = ratioStatMod("ACT_ATK_UP_CAPPED", 20, { mode: "STACKABLE", max: 2 });

    let units: readonly BattleUnit[] = [actor];
    for (const expectedCount of [1, 2]) {
      units = applyOnce(capped, units, actor, recorder, rootEventId).units;
      expect(units.find((u) => u.battleUnitId === actor.battleUnitId)!.appliedEffects).toHaveLength(
        expectedCount,
      );
    }

    const before = recorder.getEvents().length;
    const third = applyOnce(capped, units, actor, recorder, rootEventId);
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
    const completed = recorder
      .getEvents()
      .slice(before)
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("SKIPPED");
    expectCompleted(third, 1);

    const afterThird = third.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(afterThird.appliedEffects).toHaveLength(2);
    expect(afterThird.combatStats.attack).toBe(actor.baseCombatStats.attack + 40);
  });

  it("UT-R-EFF-05-020 (boundary): instances of another definition never consume this definition's stacking.max", () => {
    const actor = unit("ACTOR", "ALLY");
    const { recorder, rootEventId } = seedRecorder();
    const other = ratioStatMod("ACT_ATK_UP_OTHER", 20, { mode: "STACKABLE", max: null });
    const capped = ratioStatMod("ACT_ATK_UP_CAPPED", 20, { mode: "STACKABLE", max: 1 });

    const withOther = applyOnce(other, [actor], actor, recorder, rootEventId);
    const withCapped = applyOnce(capped, withOther.units, actor, recorder, rootEventId, [other]);

    const target = withCapped.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(2);
    expect(target.combatStats.attack).toBe(actor.baseCombatStats.attack + 40);
  });
});

describe("APPLY_DAMAGE_MOD (R-DMG-03, R-DMG-04, DMG-002 Issue #192)", () => {
  function damageModAction(
    id: string,
    payload: Extract<EffectActionDefinition, { kind: "APPLY_DAMAGE_MOD" }>["payload"],
  ): EffectActionDefinition {
    return {
      kind: "APPLY_DAMAGE_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload,
    };
  }

  const BATTLE_LONG = {
    timeLimit: { unit: "BATTLE", count: 1 },
    dispellable: true,
    linkedEffectGroupId: null,
  } as const;

  function pierceDamageAction(
    id: string,
    damageReductionIgnoreRate: number,
  ): EffectActionDefinition {
    const base = damageAction(id);
    if (base.kind !== "DAMAGE") {
      throw new Error("damageAction must build a DAMAGE EffectAction");
    }
    return {
      ...base,
      payload: {
        ...base.payload,
        piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate },
      },
    };
  }

  it("UT-R-DMG-04-010 (full stack): an APPLY_DAMAGE_MOD grants an AppliedEffect carrying the direction, damageType and evaluated signed rate", () => {
    const actor = unit("ACTOR", "ALLY");
    const mod = damageModAction("ACT_DMG_UP", {
      direction: "OUTGOING",
      damageType: "EN",
      formula: { kind: "CONSTANT", value: 0.1 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const effectActions = new Map([[mod.effectActionDefinitionId, mod]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, actor.battleUnitId, mod.effectActionDefinitionId)],
      targetUnitIds: [actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor], context);

    const updated = result.units.find((u) => u.battleUnitId === actor.battleUnitId)!;
    expect(updated.appliedEffects).toHaveLength(1);
    expect(updated.appliedEffects[0]).toMatchObject({
      effectActionDefinitionId: mod.effectActionDefinitionId,
      magnitude: 0.1,
      duplicate: true,
      damageModifier: { direction: "OUTGOING", damageType: "EN" },
    });
    expect(
      recorder.getEvents().find((e) => e.eventType === "EffectActionCompleted")!.payload.resultKind,
    ).toBe("APPLIED");
  });

  it("UT-R-DMG-04-011 (full stack): the attacker's OUTGOING and the defender's INCOMING modifiers both scale the damage of a later DAMAGE step", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const outgoing = damageModAction("ACT_DMG_UP", {
      direction: "OUTGOING",
      damageType: null,
      formula: { kind: "CONSTANT", value: 0.5 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const incoming = damageModAction("ACT_DMG_DOWN", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.2 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [outgoing.effectActionDefinitionId, outgoing],
      [incoming.effectActionDefinitionId, incoming],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, actor.battleUnitId, outgoing.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, incoming.effectActionDefinitionId),
        singleActionStep(2, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [actor.battleUnitId, target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    // 基礎ダメージ = attack 20 - defense 10 = 10、与 1.5 倍・被 0.8 倍 -> 12
    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({
      outgoingDamageMultiplier: 1.5,
      incomingDamageMultiplier: 0.8,
      finalDamage: 12,
    });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(88);
  });

  it("UT-R-DMG-03-004 (full stack): the attacking skill's damageReductionIgnoreRate cancels the defender's reduction but not its increase", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const reduction = damageModAction("ACT_DMG_DOWN", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = pierceDamageAction("ACT_PIERCE", 1);
    const effectActions = new Map([
      [reduction.effectActionDefinitionId, reduction],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, target.battleUnitId, reduction.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({
      damageReductionIgnoreRate: 1,
      incomingDamageMultiplier: 1,
      finalDamage: 10,
    });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(90);
  });

  it("UT-R-DMG-04-012 (full stack): a dynamic condition on the granted modifier is evaluated per hit, not at grant time", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY", { currentHp: 30 });
    // 「自分よりもHP割合が高い相手から攻撃された場合にのみ」被ダメージを減らす。
    const guard = damageModAction("ACT_GUARD", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      condition: { kind: "HP_RATIO_COMPARISON", left: "OPPONENT", op: "GT", right: "EFFECT_OWNER" },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [guard.effectActionDefinitionId, guard],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, target.battleUnitId, guard.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    // 攻撃側 100/100 > 対象 30/100 なので条件成立 -> 10 * 0.5 = 5
    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({ incomingDamageMultiplier: 0.5, finalDamage: 5 });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(25);
  });

  it("UT-R-DMG-04-013 (full stack): the same dynamic condition suppresses the modifier when it does not hold", () => {
    const actor = unit("ACTOR", "ALLY", { currentHp: 10 });
    const target = unit("TARGET", "ENEMY");
    const guard = damageModAction("ACT_GUARD", {
      direction: "INCOMING",
      damageType: null,
      formula: { kind: "CONSTANT", value: -0.5 },
      condition: { kind: "HP_RATIO_COMPARISON", left: "OPPONENT", op: "GT", right: "EFFECT_OWNER" },
      stacking: { mode: "STACKABLE" },
      duration: BATTLE_LONG,
    });
    const attack = damageAction("ACT_ATTACK");
    const effectActions = new Map([
      [guard.effectActionDefinitionId, guard],
      [attack.effectActionDefinitionId, attack],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, target.battleUnitId, guard.effectActionDefinitionId),
        singleActionStep(1, true, target.battleUnitId, attack.effectActionDefinitionId),
      ],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, target], context);

    const calculated = recorder.getEvents().find((e) => e.eventType === "DamageCalculated")!;
    expect(calculated.payload).toMatchObject({ incomingDamageMultiplier: 1, finalDamage: 10 });
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(90);
  });
});

describe("zero-amount shield sweep (DMG-004, Issue #194, PRレビュー再指摘[P2])", () => {
  function shieldAction(
    id: string,
    amount: number,
    linked?: { readonly groupId: string; readonly role: "PARENT" | "CHILD" },
  ): EffectActionDefinition {
    return {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: amount },
        duration: {
          timeLimit: { unit: "TURN", count: 5 },
          dispellable: true,
          linkedEffectGroupId: linked?.groupId ?? null,
          ...(linked !== undefined ? { linkedEffectGroupRole: linked.role } : {}),
        },
      },
    };
  }

  function linkedStatModAction(id: string, groupId: string): EffectActionDefinition {
    return {
      kind: "APPLY_STAT_MOD",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        stat: "ATTACK",
        valueType: "RATIO",
        formula: { kind: "CONSTANT", value: 0.15 },
        stacking: { mode: "STACKABLE", max: null },
        duration: {
          timeLimit: { unit: "TURN", count: 5 },
          dispellable: false,
          linkedEffectGroupId: groupId,
          linkedEffectGroupRole: "CHILD",
        },
      },
    };
  }

  /** `SKL_LILY_SINGER_PS2`と同じ「同一ACTION stepでPARENT→CHILDの順に付与する」形。 */
  function parentChildPlan(
    targetId: BattleUnit["battleUnitId"],
    parentId: EffectActionDefinition["effectActionDefinitionId"],
    childId: EffectActionDefinition["effectActionDefinitionId"],
  ): EffectSequencePlan {
    const actions = [{ effectActionDefinitionId: parentId }, { effectActionDefinitionId: childId }];
    return {
      stealthConsumptions: [],
      steps: [
        {
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions,
          applications: [parentId, childId].map((effectActionDefinitionId) => ({
            targetBattleUnitId: targetId,
            effectActionDefinitionId,
            includeDefeated: false,
            hits: [{ targetBattleUnitId: targetId, effectActionDefinitionId, hitIndex: 1 }],
          })),
        },
      ],
      targetUnitIds: [targetId],
      resolvedBindings: new Map(),
    };
  }

  it("UT-R-SHD-01-018: a zero-amount PARENT shield takes its later-granted CHILD with it, instead of leaving the group orphaned", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_2", "ALLY");
    // Formula結果0 → R-NUM-02の切り捨てで残量0。CHILDは同じstepの後続actionが付与する。
    const parent = shieldAction("ACT_SHIELD_ZERO", 0, { groupId: "GRP", role: "PARENT" });
    const child = linkedStatModAction("ACT_ATK_UP", "GRP");
    const effectActions = new Map([
      [parent.effectActionDefinitionId, parent],
      [child.effectActionDefinitionId, child],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);

    const result = applyEffectActionGroups(
      parentChildPlan(
        ally.battleUnitId,
        parent.effectActionDefinitionId,
        child.effectActionDefinitionId,
      ),
      [actor, ally],
      context,
    );

    // グループ全体が残らない（親も子も）。
    const target = result.units.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(target.appliedEffects).toEqual([]);

    const expired = recorder.getEvents().filter((event) => event.eventType === "EffectExpired");
    // R-EFF-09「子を先に、親を最後に」。
    expect(
      expired.map(
        (event) => (event.payload as { effectActionDefinitionId: string }).effectActionDefinitionId,
      ),
    ).toEqual(["ACT_ATK_UP", "ACT_SHIELD_ZERO"]);
    expect(expired.map((event) => (event.payload as { reason: string }).reason)).toEqual([
      "LINKED_GROUP_CASCADE",
      "SHIELD_DEPLETED",
    ]);
  });

  it("UT-R-SHD-01-019: a positive-amount shield is left alone by the sweep", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_2", "ALLY");
    const parent = shieldAction("ACT_SHIELD_OK", 30, { groupId: "GRP", role: "PARENT" });
    const child = linkedStatModAction("ACT_ATK_UP", "GRP");
    const effectActions = new Map([
      [parent.effectActionDefinitionId, parent],
      [child.effectActionDefinitionId, child],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);

    const result = applyEffectActionGroups(
      parentChildPlan(
        ally.battleUnitId,
        parent.effectActionDefinitionId,
        child.effectActionDefinitionId,
      ),
      [actor, ally],
      context,
    );

    const target = result.units.find((u) => u.battleUnitId === ally.battleUnitId)!;
    expect(target.appliedEffects).toHaveLength(2);
    expect(recorder.getEvents().some((event) => event.eventType === "EffectExpired")).toBe(false);
  });

  it("UT-R-SHD-01-020: on the PS/Memory path (no onFactEventForPassiveChain) EffectApplied is yielded to the driver while the shield still exists, before the expiry step", () => {
    const actor = unit("ACTOR", "ALLY");
    const ally = unit("ALLY_2", "ALLY");
    const shield = shieldAction("ACT_SHIELD_ZERO", 0);
    const effectActions = new Map([[shield.effectActionDefinitionId, shield]]);
    const { recorder, rootEventId } = seedRecorder();
    // callback未指定＝PS/Memory自身のEffectSequence解決の経路。
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, ally.battleUnitId, shield.effectActionDefinitionId)],
      targetUnitIds: [ally.battleUnitId],
      resolvedBindings: new Map(),
    };

    // driverを模して、yieldされたステップごとにその時点の`box.units`を観測する。
    const box = { units: [actor, ally] as readonly BattleUnit[] };
    const observed: { readonly events: readonly string[]; readonly shields: number }[] = [];
    const generator = resolveEffectSequencePlan(plan, box, context);
    let step = generator.next();
    while (!step.done) {
      const events = step.value.kind === "TIMING_EVENT" ? [step.value.event] : step.value.events;
      observed.push({
        events: events.map((event) => event.eventType),
        shields: (box.units.find((u) => u.battleUnitId === ally.battleUnitId)?.appliedEffects ?? [])
          .length,
      });
      step = generator.next();
    }

    const appliedStep = observed.findIndex((entry) => entry.events.includes("EffectApplied"));
    const expiredStep = observed.findIndex((entry) => entry.events.includes("EffectExpired"));
    expect(appliedStep).toBeGreaterThanOrEqual(0);
    // 失効は別ステップとして後から届く（同じステップに畳み込まれない）。
    expect(expiredStep).toBeGreaterThan(appliedStep);
    // `EffectApplied`をdriverが受け取る時点では、まだシールドが存在する。
    expect(observed[appliedStep]!.shields).toBe(1);
    expect(
      step.value.units.find((u) => u.battleUnitId === ally.battleUnitId)!.appliedEffects,
    ).toEqual([]);
  });
});

describe("zero-amount shield sweep on interruption (DMG-004, PRレビュー再々指摘[P2])", () => {
  it("UT-R-SHD-01-021: an interruption BETWEEN steps still expires a zero-amount shield granted by an earlier step", () => {
    // step 0: 残量0シールドを味方へ付与 → 最後のEffectActionで使用者へ自己ダメージ
    //         （致死）。step 0自体は最後のapplicationまで到達するため完了扱いになる。
    // step 1: 未解決のまま残る → 次のループ先頭の`isActorDefeated`で中断する。
    // この経路も掃除を通らなければ、残量0シールドが`EffectExpired`なしで永続する。
    const actor = unit("ACTOR", "ALLY", {
      currentHp: createHitPoint(5, 100),
    });
    const ally = unit("ALLY_2", "ALLY");
    const zeroShield: EffectActionDefinition = {
      kind: "APPLY_SHIELD",
      effectActionDefinitionId: createEffectActionDefinitionId("ACT_SHIELD_ZERO"),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        formula: { kind: "CONSTANT", value: 0 },
        duration: {
          timeLimit: { unit: "TURN", count: 5 },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
    const selfDamage = damageAction("ACT_SELF_DAMAGE");
    const laterAction = statModAction("ACT_LATER");
    const effectActions = new Map([
      [zeroShield.effectActionDefinitionId, zeroShield],
      [selfDamage.effectActionDefinitionId, selfDamage],
      [laterAction.effectActionDefinitionId, laterAction],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);

    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        {
          planKind: "ACTION_PLAN",
          stepIndex: 0,
          stepKind: "ACTION",
          conditionKind: "TRUE",
          satisfied: true,
          actions: [
            { effectActionDefinitionId: zeroShield.effectActionDefinitionId },
            { effectActionDefinitionId: selfDamage.effectActionDefinitionId },
          ],
          applications: [
            {
              targetBattleUnitId: ally.battleUnitId,
              effectActionDefinitionId: zeroShield.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetBattleUnitId: ally.battleUnitId,
                  effectActionDefinitionId: zeroShield.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            },
            {
              targetBattleUnitId: actor.battleUnitId,
              effectActionDefinitionId: selfDamage.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetBattleUnitId: actor.battleUnitId,
                  effectActionDefinitionId: selfDamage.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            },
          ],
        },
        singleActionStep(1, true, ally.battleUnitId, laterAction.effectActionDefinitionId),
      ],
      targetUnitIds: [ally.battleUnitId, actor.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, ally], context);

    // step間で中断したことを確かめる（step 0は完了、step 1は未着手）。
    // `unresolvedEffectCount: 0`が、step内の中断ではなくループ先頭の
    // `isActorDefeated`分岐を通ったことの証跡になる（step内で中断した場合は
    // 残りのヒット数が入る）。
    expect(result.outcome).toMatchObject({
      status: "INTERRUPTED",
      reason: "ACTOR_DEFEATED",
      unresolvedEffectCount: 0,
    });
    expect(result.units.find((u) => u.battleUnitId === actor.battleUnitId)!.currentHp).toBe(0);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectStepCompleted")).toHaveLength(
      1,
    );

    // 中断経路でも残量0シールドは掃除される。
    const expired = recorder.getEvents().filter((event) => event.eventType === "EffectExpired");
    expect(expired).toHaveLength(1);
    expect(expired[0]!.payload).toMatchObject({
      effectActionDefinitionId: "ACT_SHIELD_ZERO",
      reason: "SHIELD_DEPLETED",
    });
    expect(result.units.find((u) => u.battleUnitId === ally.battleUnitId)!.appliedEffects).toEqual(
      [],
    );
  });
});

describe("APPLY_CONTINUOUS_DAMAGE (R-DOT-01〜04, DMG-008 Issue #189)", () => {
  function continuousDamage(
    id: string,
    continuousDamageKind: "FIXED" | "BURN" | "POISON",
    ratio: number,
    durationCount = 3,
  ): EffectActionDefinition {
    return {
      kind: "APPLY_CONTINUOUS_DAMAGE",
      effectActionDefinitionId: createEffectActionDefinitionId(id),
      requiredCapabilities: [],
      metadata: { tags: [] },
      payload: {
        continuousDamageKind,
        damageType: "PHYSICAL",
        formula:
          continuousDamageKind === "POISON"
            ? { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio }
            : { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio },
        timing: { eventType: "ActionStarted", targetSelector: "EFFECT_OWNER" },
        duration: {
          timeLimit: { unit: "ACTION", count: durationCount },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      },
    };
  }

  function applyOnce(
    definition: EffectActionDefinition,
    units: readonly BattleUnit[],
    actor: BattleUnit,
    target: BattleUnit,
    recorder: EventRecorder,
    rootEventId: string,
    // R-DOT-04の統合は既存インスタンスの定義もCatalogから引くため、production経路と
    // 同じく「その戦闘に登場する全定義」を渡せるようにする。
    known: readonly EffectActionDefinition[] = [],
  ): EffectActionGroupsResult {
    const effectActions = new Map(
      [...known, definition].map((d) => [d.effectActionDefinitionId, d]),
    );
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [singleActionStep(0, true, target.battleUnitId, definition.effectActionDefinitionId)],
      targetUnitIds: [target.battleUnitId],
      resolvedBindings: new Map(),
    };
    return applyEffectActionGroups(
      plan,
      units,
      contextFor(actor, effectActions, recorder, rootEventId),
    );
  }

  it("UT-R-DOT-01-006 (real lifecycle wiring): granting a continuous damage records the granter's attack as a snapshot and carries the kind on the instance", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const { recorder, rootEventId } = seedRecorder();

    const result = applyOnce(
      continuousDamage("ACT_DOT", "FIXED", 0.3),
      [actor, target],
      actor,
      target,
      recorder,
      rootEventId,
    );

    const applied = result.units.find((u) => u.battleUnitId === target.battleUnitId)!
      .appliedEffects[0]!;
    expect(applied.continuousDamage).toEqual({
      continuousDamageKind: "FIXED",
      damageType: "PHYSICAL",
    });
    // R-DOT-01: 付与者の攻撃力そのものをスナップショットとして持つ。
    expect(applied.snapshot).toEqual({ sourceAttack: actor.combatStats.attack });
    // 付与時に一度だけ評価したFormula結果＝固定ダメージ量。
    expect(applied.magnitude).toBe(actor.combatStats.attack * 0.3);
    // 付与時点ではダメージを与えない（発生は保持者のActionStarted）。
    expect(result.units.find((u) => u.battleUnitId === target.battleUnitId)!.currentHp).toBe(
      target.currentHp,
    );
  });

  it("UT-R-DOT-03-003 (negative, 重複上限): a fourth burn is not granted and completes as SKIPPED without EffectApplied", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const { recorder, rootEventId } = seedRecorder();
    const burn = continuousDamage("ACT_BURN", "BURN", 0.3);

    let units: readonly BattleUnit[] = [actor, target];
    for (const expectedCount of [1, 2, 3]) {
      units = applyOnce(burn, units, actor, target, recorder, rootEventId).units;
      expect(
        units.find((u) => u.battleUnitId === target.battleUnitId)!.appliedEffects,
      ).toHaveLength(expectedCount);
    }

    const before = recorder.getEvents().length;
    const fourth = applyOnce(burn, units, actor, target, recorder, rootEventId);
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
    const completed = recorder
      .getEvents()
      .slice(before)
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("SKIPPED");
    expect(
      fourth.units.find((u) => u.battleUnitId === target.battleUnitId)!.appliedEffects,
    ).toHaveLength(3);
  });

  it("UT-R-DOT-04-008 (real lifecycle wiring): re-applying a poison merges into the existing instance instead of adding a second one", () => {
    const actor = unit("ACTOR", "ALLY");
    const target = unit("TARGET", "ENEMY");
    const { recorder, rootEventId } = seedRecorder();

    const weak = continuousDamage("ACT_POISON_A", "POISON", 0.1, 1);
    const strong = continuousDamage("ACT_POISON_B", "POISON", 0.2, 4);

    const first = applyOnce(weak, [actor, target], actor, target, recorder, rootEventId, [strong]);
    const second = applyOnce(strong, first.units, actor, target, recorder, rootEventId, [weak]);

    const effects = second.units.find(
      (u) => u.battleUnitId === target.battleUnitId,
    )!.appliedEffects;
    expect(effects).toHaveLength(1);
    expect(effects[0]!.duration.timeLimitRemaining).toBe(4);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectMerged")).toHaveLength(1);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectApplied")).toHaveLength(1);
  });
});

/**
 * PR #289再々レビュー[P2]（DMG-005、Issue #190）: R-SUB-02のサブユニット追加ヒットは
 * `application.hits`に含まれないため、その解決中に使用者が戦闘不能になっても
 * `interruptedCount`は0のままになる。中断が`ApplyDamageActionResult.interrupted`として
 * 外側へ伝わり、`EffectActionCompleted`が`INTERRUPTED`になって後続stepへ進まないことを、
 * 実resolver経路で固定する。
 */
describe("sub-unit additional damage interruption (R-SUB-02 / R-SKL-01, PR #289 再々レビュー)", () => {
  const OWNER_SUBUNIT_ID = createEffectActionDefinitionId("ACT_OWNER_SUBUNIT");
  const TARGET_SUBUNIT_ID = createEffectActionDefinitionId("ACT_TARGET_SUBUNIT");

  function subUnitEffect(
    instanceId: string,
    definitionId: EffectActionDefinition["effectActionDefinitionId"],
    holderId: BattleUnit["battleUnitId"],
    durability: number,
  ): AppliedEffect {
    return {
      effectInstanceId: createEffectInstanceId(instanceId),
      effectActionDefinitionId: definitionId,
      kindKey: effectKindKeyFromDefinitionId(definitionId),
      duplicate: true,
      targetId: holderId,
      magnitude: durability,
      categories: ["SUBUNIT"],
      subUnit: {
        durability,
        additionalDamage: {
          formula: {
            kind: "SUBUNIT_ADDITIONAL_DAMAGE",
            ownerAttack: "CURRENT_ATTACK",
            providerAttack: "SOURCE_SNAPSHOT_ATTACK",
            skillMultiplier: 0.5,
            targetDefense: "TARGET_CURRENT_DEFENSE",
          },
        },
      },
      snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: 100 },
      duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
      appliedTurnNumber: 1,
    };
  }

  it("UT-R-SUB-02-016: a SubUnitDamaged chain that defeats the actor during the additional hit reports INTERRUPTED and never starts the next step", () => {
    const actorBase = unit("ACTOR", "ALLY");
    // 使用者がサブユニットを持つので、通常ヒットの後に追加ヒットが1回発生する。
    const actor: BattleUnit = {
      ...actorBase,
      appliedEffects: [subUnitEffect("OWNER_SUB", OWNER_SUBUNIT_ID, actorBase.battleUnitId, 50)],
    };
    // 対象もサブユニットを持つので、追加ヒットが`SubUnitDamaged`を発行する。
    // 耐久力200のサブユニットが通常ヒット(10)も追加ヒット(20 + 100×0.5 - 10 = 60)も
    // 吸収しきるため、対象は戦闘不能にならず中断要因が使用者側だけに絞られる。
    const enemyBase = unit("ENEMY", "ENEMY");
    const enemy: BattleUnit = {
      ...enemyBase,
      appliedEffects: [subUnitEffect("TARGET_SUB", TARGET_SUBUNIT_ID, enemyBase.battleUnitId, 200)],
    };
    const attack = damageAction("ACT_ATTACK");
    const second = damageAction("ACT_SECOND");
    const effectActions = new Map([
      [attack.effectActionDefinitionId, attack],
      [second.effectActionDefinitionId, second],
    ]);
    const { recorder, rootEventId } = seedRecorder();
    // 追加ヒット（`effectActionDefinitionId`が使用者のサブユニット定義）の
    // `SubUnitDamaged`にだけ反応して使用者を倒す。通常ヒット側の`SubUnitDamaged`
    // （`ACT_ATTACK`）では発火しないため、中断は追加ヒットの最中に起きる。
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      if (
        event.eventType !== "SubUnitDamaged" ||
        event.payload.effectActionDefinitionId !== OWNER_SUBUNIT_ID
      ) {
        return units;
      }
      return units.map((u) =>
        u.battleUnitId === actor.battleUnitId ? { ...u, currentHp: createHitPoint(0, 100) } : u,
      );
    });
    const plan: EffectSequencePlan = {
      stealthConsumptions: [],
      steps: [
        singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId),
        singleActionStep(1, true, enemy.battleUnitId, second.effectActionDefinitionId),
      ],
      targetUnitIds: [enemy.battleUnitId],
      resolvedBindings: new Map(),
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    // 追加ヒットの`SubUnitDamaged`連鎖が使用者を倒したので、この解決は中断扱いになる。
    expect(result.outcome.status).toBe("INTERRUPTED");
    const completed = recorder
      .getEvents()
      .filter((e) => e.eventType === "EffectActionCompleted")
      .map((e) => e.payload.resultKind);
    expect(completed).toEqual(["INTERRUPTED"]);
    // 後続stepのEffectActionは一度も開始されない（R-SKL-01「未解決効果を中断する」）。
    expect(
      recorder
        .getEvents()
        .some(
          (e) =>
            e.eventType === "EffectActionStarting" &&
            e.payload.effectActionDefinitionId === second.effectActionDefinitionId,
        ),
    ).toBe(false);
    expect(recorder.getEvents().filter((e) => e.eventType === "EffectStepCompleted")).toEqual([]);
  });
});
