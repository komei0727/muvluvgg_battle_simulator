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
import type { EffectSequencePlan, ResolvedBinding } from "../skill/skill-resolution-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId } from "../../shared/event-ids.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
  type TargetBindingId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectStepDefinition } from "../../catalog/definitions/effect-sequence.js";
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

function fixedRandom(...values: readonly number[]): RandomSource {
  let index = 0;
  return {
    next(): number {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error("fixedRandom exhausted");
      }
      return value;
    },
  };
}

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

function contextWithRandom(
  actor: BattleUnit,
  effectActions: BattleDefinitions["effectActions"],
  recorder: EventRecorder,
  rootEventId: string,
  random: RandomSource,
  onFactEventForPassiveChain?: EffectActionGroupContext["onFactEventForPassiveChain"],
): EffectActionGroupContext {
  return {
    ...contextFor(actor, effectActions, recorder, rootEventId, onFactEventForPassiveChain),
    random,
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
    stepIndex,
    stepKind: "ACTION",
    conditionKind: satisfied ? "TRUE" : "NOT",
    satisfied,
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
          actions: [
            { effectActionDefinitionId: selfHit.effectActionDefinitionId },
            { effectActionDefinitionId: otherHit.effectActionDefinitionId },
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

  function deferredStep(
    stepIndex: number,
    definition: EffectStepDefinition,
  ): EffectSequencePlan["steps"][number] {
    return { stepIndex, stepKind: "DEFERRED", definitionKind: definition.kind, definition };
  }

  function bindingsFor(
    targetBindingId: ReturnType<typeof createTargetBindingId>,
    units: readonly BattleUnit[],
  ): Map<TargetBindingId, ResolvedBinding> {
    return new Map([[targetBindingId, { units, includeDefeated: false }]]);
  }

  describe("R-SKL-07: BRANCH / RANDOM_BRANCH / REPEAT (RES-003, Issue #173)", () => {
    it("UT-R-SKL-07-001: a BRANCH step with a true condition resolves thenSteps (in order) and never touches elseSteps", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const thenAttack = damageAction("ACT_THEN");
      const elseAttack = damageAction("ACT_ELSE");
      const effectActions = new Map([
        [thenAttack.effectActionDefinitionId, thenAttack],
        [elseAttack.effectActionDefinitionId, elseAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const branchDefinition: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: thenAttack.effectActionDefinitionId }],
          },
        ],
        elseSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: elseAttack.effectActionDefinitionId }],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const before = recorder.getEvents().length;
      applyEffectActionGroups(plan, [actor, enemy], context);
      const emitted = recorder.getEvents().slice(before);

      expect(emitted.map((e) => e.eventType)).toEqual([
        "EffectStepStarting",
        "EffectStepStarting",
        "EffectActionStarting",
        "UnitBeingAttacked",
        "HitConfirmed",
        "CriticalCheckResolved",
        "DamageCalculated",
        "DamageApplied",
        "EffectActionCompleted",
        "EffectStepCompleted",
        "EffectStepCompleted",
      ]);
      const stepStartings = emitted.filter((e) => e.eventType === "EffectStepStarting");
      expect(stepStartings.map((e) => e.payload.stepKind)).toEqual(["BRANCH", "ACTION"]);
      const actionCompleted = emitted.find(
        (e) => e.eventType === "EffectActionCompleted",
      ) as Extract<BattleDomainEvent, { eventType: "EffectActionCompleted" }>;
      expect(actionCompleted.payload.effectActionDefinitionId).toBe(
        thenAttack.effectActionDefinitionId,
      );
    });

    it("UT-R-SKL-07-002: a BRANCH step with a false condition resolves elseSteps instead of thenSteps", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const thenAttack = damageAction("ACT_THEN");
      const elseAttack = damageAction("ACT_ELSE");
      const effectActions = new Map([
        [thenAttack.effectActionDefinitionId, thenAttack],
        [elseAttack.effectActionDefinitionId, elseAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const branchDefinition: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "NOT", condition: { kind: "TRUE" } },
        thenSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: thenAttack.effectActionDefinitionId }],
          },
        ],
        elseSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: elseAttack.effectActionDefinitionId }],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      const actionCompleted = recorder
        .getEvents()
        .find((e) => e.eventType === "EffectActionCompleted") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionCompleted" }
      >;
      expect(actionCompleted.payload.effectActionDefinitionId).toBe(
        elseAttack.effectActionDefinitionId,
      );
    });

    it("UT-R-SKL-07-003: RANDOM_BRANCH WEIGHTED_ONE consumes RNG exactly once, resolves only the selected branch's steps, and records RandomBranchSelected", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const branchAAttack = damageAction("ACT_BRANCH_A");
      const branchBAttack = damageAction("ACT_BRANCH_B");
      const effectActions = new Map([
        [branchAAttack.effectActionDefinitionId, branchAAttack],
        [branchBAttack.effectActionDefinitionId, branchBAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      // next()=0 -> roll=0 out of totalWeight=4 -> falls in branch A's [0,1) range.
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "A",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchAAttack.effectActionDefinitionId }],
              },
            ],
          },
          {
            label: "B",
            weight: 3,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchBAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      const selected = events.find((e) => e.eventType === "RandomBranchSelected") as Extract<
        BattleDomainEvent,
        { eventType: "RandomBranchSelected" }
      >;
      expect(selected.payload).toEqual({
        stepIndex: 0,
        mode: "WEIGHTED_ONE",
        branchIndex: 0,
        label: "A",
      });
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(1);
      const actionStarting = events.find((e) => e.eventType === "EffectActionStarting") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionStarting" }
      >;
      expect(actionStarting.payload.effectActionDefinitionId).toBe(
        branchAAttack.effectActionDefinitionId,
      );
    });

    it("UT-R-SKL-07-004: RANDOM_BRANCH INDEPENDENT rolls each branch's probability independently in Catalog definition order, resolving every branch that succeeds", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const branchAAttack = damageAction("ACT_BRANCH_A");
      const branchBAttack = damageAction("ACT_BRANCH_B");
      const effectActions = new Map([
        [branchAAttack.effectActionDefinitionId, branchAAttack],
        [branchBAttack.effectActionDefinitionId, branchBAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      // Branch A: probability 0.3, roll 0.5 -> 0.5 < 0.3 is false -> fails.
      // Branch B: probability 0.9, roll 0.1 -> 0.1 < 0.9 is true -> succeeds.
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0.5, 0.1),
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [
          {
            label: "A",
            probability: 0.3,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchAAttack.effectActionDefinitionId }],
              },
            ],
          },
          {
            label: "B",
            probability: 0.9,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchBAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      const selectedEvents = events.filter((e) => e.eventType === "RandomBranchSelected");
      expect(selectedEvents).toHaveLength(1);
      expect(selectedEvents[0]?.payload).toEqual({
        stepIndex: 0,
        mode: "INDEPENDENT",
        branchIndex: 1,
        label: "B",
      });
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(1);
      const actionStarting = events.find((e) => e.eventType === "EffectActionStarting") as Extract<
        BattleDomainEvent,
        { eventType: "EffectActionStarting" }
      >;
      expect(actionStarting.payload.effectActionDefinitionId).toBe(
        branchBAttack.effectActionDefinitionId,
      );
    });

    it("UT-R-SKL-07-005: REPEAT resolves steps the given number of times, in order, aggregating resolvedActionCount", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const attack = damageAction("ACT_ATTACK");
      const effectActions = new Map([[attack.effectActionDefinitionId, attack]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const repeatDefinition: EffectStepDefinition = {
        kind: "REPEAT",
        count: 3,
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: attack.effectActionDefinitionId }],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, repeatDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(3);
      // 4 EffectStepCompleted total: one per iteration's nested ACTION step
      // (resolvedActionCount: 1 each), plus the REPEAT step's own wrapper
      // (resolvedActionCount: 3, aggregated) emitted last.
      const stepCompletedEvents = events.filter((e) => e.eventType === "EffectStepCompleted");
      expect(stepCompletedEvents).toHaveLength(4);
      expect(stepCompletedEvents.at(-1)?.payload).toEqual({
        stepIndex: 0,
        resolvedActionCount: 3,
      });
    });

    it("UT-R-SKL-07-006 (boundary): REPEAT aborts remaining iterations when the actor becomes defeated mid-loop, without emitting EffectStepCompleted for the REPEAT step", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const selfHit = damageAction("ACT_SELF_HIT");
      const effectActions = new Map([[selfHit.effectActionDefinitionId, selfHit]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const tgtSelf = createTargetBindingId("TGT_SELF");
      const repeatDefinition: EffectStepDefinition = {
        kind: "REPEAT",
        count: 3,
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtSelf },
            actions: [{ effectActionDefinitionId: selfHit.effectActionDefinitionId }],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, repeatDefinition)],
        targetUnitIds: [actor.battleUnitId],
        resolvedBindings: bindingsFor(tgtSelf, [actor]),
      };

      const result = applyEffectActionGroups(plan, [actor], context);

      const events = recorder.getEvents();
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(1);
      // The lethal self-hit's own nested ACTION step completes normally (its
      // EffectStepCompleted fires) — the interrupt only prevents further
      // REPEAT iterations from starting, so the REPEAT step's own
      // EffectStepCompleted (which would be the second one) never fires.
      expect(events.filter((e) => e.eventType === "EffectStepCompleted")).toHaveLength(1);
      expect(result.resolvedCount).toBe(1);
      // PR #216再々々々レビュー[P1]: the actor died on iteration 0's hit, so
      // iterations 1 and 2 (2 remaining) never even started — each would
      // have contributed 1 hit (1 target x hitCount 1), so 2 hits are
      // unresolved rather than silently reported as interruptedCount: 0.
      expect(result.interruptedCount).toBe(2);
    });

    it("UT-R-SKL-07-007 (R-SKL-01, PR #216レビュー[P1]): RandomBranchSelected participates in the PS/Memory immediate chain (onFactEventForPassiveChain observes it), not just recorder.getEvents()", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const branchAttack = damageAction("ACT_BRANCH");
      const effectActions = new Map([[branchAttack.effectActionDefinitionId, branchAttack]]);
      const { recorder, rootEventId } = seedRecorder();
      const observedEventTypes: string[] = [];
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          observedEventTypes.push(event.eventType);
          return units;
        },
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      // Before the fix, RandomBranchSelected was only recorder.record()ed,
      // never yielded, so onFactEventForPassiveChain never observed it.
      expect(observedEventTypes).toContain("RandomBranchSelected");
    });

    it("UT-R-SKL-07-009 (R-SKL-01, PR #216再レビュー[P1]): when the RandomBranchSelected immediate chain defeats the actor before the chosen (non-empty) branch resolves, the branch's unresolved hits count as interrupted instead of silently reporting interruptedCount: 0", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      // hitCount: 2, so the chosen branch's single target contributes 2
      // candidate hits (1 target x 2 hits) once selected.
      const branchAttack = damageAction("ACT_BRANCH", 2);
      const effectActions = new Map([[branchAttack.effectActionDefinitionId, branchAttack]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          // Simulate a PS reacting to the branch selection itself with
          // lethal self-damage, before the chosen branch's own DAMAGE step
          // ever gets a chance to start.
          if (event.eventType === "RandomBranchSelected") {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      // The branch's own DAMAGE step never started at all.
      const events = recorder.getEvents();
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(0);
      // ...yet its unresolved hits are still counted as interrupted, so
      // action-skill-use-resolver.ts's `interruptedCount > 0` check correctly
      // emits SkillUseInterrupted instead of SkillUseCompleted.
      expect(result.interruptedCount).toBe(2);
      expect(result.resolvedCount).toBe(0);
    });

    it("UT-R-SKL-07-010 (PR #216再々レビュー[P1]): an abandoned branch whose ACTION targets LAST_ACTION_TARGETS still counts its would-be hits as interrupted, resolved from lastResultBox rather than as 0", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      const initialAttack = damageAction("ACT_INITIAL");
      // hitCount: 3, so LAST_ACTION_TARGETS (1 unit, from the preceding
      // singleActionStep) contributes 1 target x 3 hits = 3.
      const branchAttack = damageAction("ACT_BRANCH_LAST_ACTION", 3);
      const effectActions = new Map([
        [initialAttack.effectActionDefinitionId, initialAttack],
        [branchAttack.effectActionDefinitionId, branchAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          if (event.eventType === "RandomBranchSelected") {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "LAST_ACTION_TARGETS" },
                actions: [{ effectActionDefinitionId: branchAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, enemy.battleUnitId, initialAttack.effectActionDefinitionId),
          deferredStep(1, randomBranchDefinition),
        ],
        targetUnitIds: [enemy.battleUnitId],
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      expect(result.resolvedCount).toBe(1); // the preceding singleActionStep hit.
      expect(result.interruptedCount).toBe(3);
    });

    it("UT-R-SKL-07-011 (PR #216再々レビュー[P1]): an abandoned branch whose ACTION targets LAST_DAMAGED_TARGETS still counts its would-be hits as interrupted, resolved from lastResultBox rather than as 0", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      const initialAttack = damageAction("ACT_INITIAL");
      const branchAttack = damageAction("ACT_BRANCH_LAST_DAMAGED", 4);
      const effectActions = new Map([
        [initialAttack.effectActionDefinitionId, initialAttack],
        [branchAttack.effectActionDefinitionId, branchAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          if (event.eventType === "RandomBranchSelected") {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "LAST_DAMAGED_TARGETS" },
                actions: [{ effectActionDefinitionId: branchAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, enemy.battleUnitId, initialAttack.effectActionDefinitionId),
          deferredStep(1, randomBranchDefinition),
        ],
        targetUnitIds: [enemy.battleUnitId],
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      expect(result.resolvedCount).toBe(1);
      expect(result.interruptedCount).toBe(4);
    });

    it("UT-R-SKL-07-012 (PR #216再々レビュー[P1]): an abandoned branch containing a nested BRANCH counts only the side its condition actually resolves to, not both thenSteps and elseSteps summed", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      // thenSteps hitCount 2, elseSteps hitCount 5 — condition TRUE always
      // resolves thenSteps, so the correct candidate count is 2, not 2 + 5.
      const thenAttack = damageAction("ACT_THEN", 2);
      const elseAttack = damageAction("ACT_ELSE", 5);
      const effectActions = new Map([
        [thenAttack.effectActionDefinitionId, thenAttack],
        [elseAttack.effectActionDefinitionId, elseAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          if (event.eventType === "RandomBranchSelected") {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "BRANCH",
                condition: { kind: "TRUE" },
                thenSteps: [
                  {
                    kind: "ACTION",
                    condition: { kind: "TRUE" },
                    target: { kind: "BINDING", targetBindingId: tgtEnemy },
                    actions: [{ effectActionDefinitionId: thenAttack.effectActionDefinitionId }],
                  },
                ],
                elseSteps: [
                  {
                    kind: "ACTION",
                    condition: { kind: "TRUE" },
                    target: { kind: "BINDING", targetBindingId: tgtEnemy },
                    actions: [{ effectActionDefinitionId: elseAttack.effectActionDefinitionId }],
                  },
                ],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      expect(result.interruptedCount).toBe(2);
      expect(result.resolvedCount).toBe(0);
    });

    it("UT-R-SKL-07-013 (PR #216再々々レビュー[P1]): an abandoned branch whose only ACTION has a false condition contributes zero interrupted hits, since R-SKL-06 would have skipped it entirely rather than applying it", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      const skippedAttack = damageAction("ACT_SKIPPED", 3);
      const effectActions = new Map([[skippedAttack.effectActionDefinitionId, skippedAttack]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          if (event.eventType === "RandomBranchSelected") {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "NOT", condition: { kind: "TRUE" } },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: skippedAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      expect(result.interruptedCount).toBe(0);
      expect(result.resolvedCount).toBe(0);
    });

    it("UT-R-SKL-07-014 (PR #216再々々々レビュー[P1]): once a RandomBranchSelected chain interrupts the sequence, later top-level steps (both a plain ACTION and a DEFERRED step) still contribute their unresolved hits to interruptedCount instead of being silently dropped", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      const branchAttack = damageAction("ACT_BRANCH", 1);
      // hitCount 1: the singleActionStep() fixture helper always constructs
      // exactly one hit regardless of the underlying EffectActionDefinition's
      // hitCount, so this must match that to keep the expected total exact.
      const laterAttack = damageAction("ACT_LATER");
      const deferredAttack = damageAction("ACT_DEFERRED", 3);
      const effectActions = new Map([
        [branchAttack.effectActionDefinitionId, branchAttack],
        [laterAttack.effectActionDefinitionId, laterAttack],
        [deferredAttack.effectActionDefinitionId, deferredAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          if (event.eventType === "RandomBranchSelected") {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      // A later DEFERRED step (BRANCH stays a DeferredStepPlan regardless of
      // its condition; using BRANCH here — rather than a LAST_RESULT-gated
      // ACTION — avoids depending on a preceding result that, in this
      // scenario, never actually gets produced).
      const laterDeferredStep: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: deferredAttack.effectActionDefinitionId }],
          },
        ],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [
          deferredStep(0, randomBranchDefinition),
          singleActionStep(1, true, enemy.battleUnitId, laterAttack.effectActionDefinitionId),
          deferredStep(2, laterDeferredStep),
        ],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      // Nothing at all resolves: the RANDOM_BRANCH's own branch is
      // abandoned (1 hit), the later plain ACTION step never starts (1
      // hit), and the later DEFERRED step never starts either (3 hits).
      expect(result.resolvedCount).toBe(0);
      expect(result.interruptedCount).toBe(1 + 1 + 3);
    });

    it("UT-R-SKL-07-016 (PR #216再々々々々レビュー[P1]): a nested step whose own last hit defeats the actor leaves the very next sibling step unresolved, and that sibling's candidate hits are still counted (not silently dropped just because sequenceInterrupted wasn't set before entering it)", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      const selfHit = damageAction("ACT_SELF_HIT");
      const followUpAttack = damageAction("ACT_FOLLOW_UP", 4);
      const effectActions = new Map([
        [selfHit.effectActionDefinitionId, selfHit],
        [followUpAttack.effectActionDefinitionId, followUpAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      // No PS/Memory hook needed here — the self-hit's own damage naturally
      // defeats the actor, with nothing setting sequenceInterrupted before
      // resolveStepDefinitionList moves on to the second (follow-up) step.
      const branchDefinition: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "SELF" },
            actions: [{ effectActionDefinitionId: selfHit.effectActionDefinitionId }],
          },
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: followUpAttack.effectActionDefinitionId }],
          },
        ],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branchDefinition)],
        targetUnitIds: [actor.battleUnitId, enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      // Only the self-hit's own EffectActionStarting ever fires.
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(1);
      expect(result.resolvedCount).toBe(1); // the self-hit itself.
      expect(result.interruptedCount).toBe(4); // the follow-up's would-be hits.
    });

    it("UT-R-SKL-07-017 (PR #216再々々々々レビュー[P1]): a BRANCH step interrupted by its own EffectStepStarting immediate chain counts the candidate hits of the side its condition would have resolved to", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const branchAttack = damageAction("ACT_BRANCH", 3);
      const effectActions = new Map([[branchAttack.effectActionDefinitionId, branchAttack]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
        if (event.eventType === "EffectStepStarting" && event.payload.stepKind === "BRANCH") {
          return units.map((unit) =>
            unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
          );
        }
        return units;
      });
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const branchDefinition: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: branchAttack.effectActionDefinitionId }],
          },
        ],
        elseSteps: [],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(0);
      expect(result.resolvedCount).toBe(0);
      expect(result.interruptedCount).toBe(3);
    });

    it("UT-R-SKL-07-018 (PR #216再々々々々レビュー[P1]): a RANDOM_BRANCH step interrupted by its own EffectStepStarting immediate chain (before any branch is even selected) counts the candidate hits of its single branch", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const branchAttack = damageAction("ACT_BRANCH", 5);
      const effectActions = new Map([[branchAttack.effectActionDefinitionId, branchAttack]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        // NO_RANDOM throws if consumed — the whole point is that the chain
        // interrupts before branch selection even rolls.
        NO_RANDOM,
        (event, units) => {
          if (
            event.eventType === "EffectStepStarting" &&
            event.payload.stepKind === "RANDOM_BRANCH"
          ) {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: branchAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      expect(events.some((e) => e.eventType === "RandomBranchSelected")).toBe(false);
      expect(result.resolvedCount).toBe(0);
      expect(result.interruptedCount).toBe(5);
    });

    it("UT-R-SKL-07-019 (PR #216再々々々々レビュー[P1]): a REPEAT step interrupted by its own EffectStepStarting immediate chain (before the first iteration even starts) counts all count iterations as unresolved", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const repeatAttack = damageAction("ACT_REPEAT", 2);
      const effectActions = new Map([[repeatAttack.effectActionDefinitionId, repeatAttack]]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
        if (event.eventType === "EffectStepStarting" && event.payload.stepKind === "REPEAT") {
          return units.map((unit) =>
            unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
          );
        }
        return units;
      });
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const repeatDefinition: EffectStepDefinition = {
        kind: "REPEAT",
        count: 3,
        steps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy },
            actions: [{ effectActionDefinitionId: repeatAttack.effectActionDefinitionId }],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, repeatDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(0);
      expect(result.resolvedCount).toBe(0);
      // 3 iterations x (1 target x 2 hits) = 6, all unresolved since none
      // even started.
      expect(result.interruptedCount).toBe(6);
    });

    it("UT-R-SKL-07-020 (PR #216再々々々々々レビュー[P1]): within an abandoned subtree, a LAST_ACTION_TARGETS ACTION correctly sees the preceding (also-abandoned) BINDING ACTION's target instead of a stale/empty real lastResultBox", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      // hitCount 1 and 3: if the estimator incorrectly used the real (empty)
      // lastResultBox instead of simulating the first step's own result, the
      // follow-up's target count would be 0 instead of 1.
      const firstAttack = damageAction("ACT_FIRST", 1);
      const followUpAttack = damageAction("ACT_FOLLOW_UP", 3);
      const effectActions = new Map([
        [firstAttack.effectActionDefinitionId, firstAttack],
        [followUpAttack.effectActionDefinitionId, followUpAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
        (event, units) => {
          if (event.eventType === "RandomBranchSelected") {
            return units.map((unit) =>
              unit.battleUnitId === actor.battleUnitId ? { ...unit, currentHp: 0 } : unit,
            );
          }
          return units;
        },
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "WEIGHTED_ONE",
        branches: [
          {
            label: "ONLY",
            weight: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [{ effectActionDefinitionId: firstAttack.effectActionDefinitionId }],
              },
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "LAST_ACTION_TARGETS" },
                actions: [{ effectActionDefinitionId: followUpAttack.effectActionDefinitionId }],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(0);
      expect(result.resolvedCount).toBe(0);
      expect(result.interruptedCount).toBe(1 + 3);
    });

    it("UT-R-SKL-07-021 (PR #216再々々々々々レビュー[P1]): INDEPENDENT RANDOM_BRANCH counts a not-yet-rolled remaining branch's candidate hits when a preceding branch's own lethal hit interrupts the sequence before the next branch's probability roll", () => {
      const actor = unit("ACTOR", "ALLY", { currentHp: 5 });
      const enemy = unit("ENEMY", "ENEMY");
      const selfHit = damageAction("ACT_SELF_HIT");
      const secondBranchAttack = damageAction("ACT_SECOND", 4);
      const effectActions = new Map([
        [selfHit.effectActionDefinitionId, selfHit],
        [secondBranchAttack.effectActionDefinitionId, secondBranchAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      // Only branch A's probability roll should ever happen (organically
      // interrupted by its own lethal self-hit before branch B is even
      // considered) — fixedRandom(0) throws if consumed a second time,
      // proving branch B's roll never happens yet its hits are still
      // counted as unresolved.
      const context = contextWithRandom(
        actor,
        effectActions,
        recorder,
        rootEventId,
        fixedRandom(0),
      );
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const randomBranchDefinition: EffectStepDefinition = {
        kind: "RANDOM_BRANCH",
        mode: "INDEPENDENT",
        branches: [
          {
            label: "A",
            probability: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "SELF" },
                actions: [{ effectActionDefinitionId: selfHit.effectActionDefinitionId }],
              },
            ],
          },
          {
            label: "B",
            probability: 1,
            steps: [
              {
                kind: "ACTION",
                condition: { kind: "TRUE" },
                target: { kind: "BINDING", targetBindingId: tgtEnemy },
                actions: [
                  { effectActionDefinitionId: secondBranchAttack.effectActionDefinitionId },
                ],
              },
            ],
          },
        ],
      };
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, randomBranchDefinition)],
        targetUnitIds: [actor.battleUnitId, enemy.battleUnitId],
        resolvedBindings: bindingsFor(tgtEnemy, [enemy]),
      };

      const result = applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      expect(events.filter((e) => e.eventType === "EffectActionStarting")).toHaveLength(1);
      expect(result.resolvedCount).toBe(1); // branch A's self-hit.
      expect(result.interruptedCount).toBe(4); // branch B's never-rolled candidate hits.
    });
  });

  describe("R-SKL-08: 直前結果 (RES-003, Issue #173)", () => {
    it("UT-R-SKL-08-005: a LAST_RESULT condition sees the result produced inside a preceding BRANCH's thenSteps, not just a sibling ACTION step", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy1 = unit("ENEMY_1", "ENEMY");
      const enemy2 = unit("ENEMY_2", "ENEMY");
      const insideBranchAttack = damageAction("ACT_INSIDE_BRANCH");
      const afterBranchAttack = damageAction("ACT_AFTER_BRANCH");
      const effectActions = new Map([
        [insideBranchAttack.effectActionDefinitionId, insideBranchAttack],
        [afterBranchAttack.effectActionDefinitionId, afterBranchAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const tgtEnemy1 = createTargetBindingId("TGT_ENEMY_1");
      const tgtEnemy2 = createTargetBindingId("TGT_ENEMY_2");
      const branchDefinition: EffectStepDefinition = {
        kind: "BRANCH",
        condition: { kind: "TRUE" },
        thenSteps: [
          {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "BINDING", targetBindingId: tgtEnemy1 },
            actions: [{ effectActionDefinitionId: insideBranchAttack.effectActionDefinitionId }],
          },
        ],
        elseSteps: [],
      };
      const afterBranchStep: EffectStepDefinition = {
        kind: "ACTION",
        condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "APPLIED" },
        target: { kind: "BINDING", targetBindingId: tgtEnemy2 },
        actions: [{ effectActionDefinitionId: afterBranchAttack.effectActionDefinitionId }],
      };
      const resolvedBindings = new Map<TargetBindingId, ResolvedBinding>([
        [tgtEnemy1, { units: [enemy1], includeDefeated: false }],
        [tgtEnemy2, { units: [enemy2], includeDefeated: false }],
      ]);
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, branchDefinition), deferredStep(1, afterBranchStep)],
        targetUnitIds: [enemy1.battleUnitId, enemy2.battleUnitId],
        resolvedBindings,
      };

      applyEffectActionGroups(plan, [actor, enemy1, enemy2], context);

      const events = recorder.getEvents();
      const actionStartings = events.filter((e) => e.eventType === "EffectActionStarting");
      expect(actionStartings.map((e) => e.payload.effectActionDefinitionId)).toEqual([
        insideBranchAttack.effectActionDefinitionId,
        afterBranchAttack.effectActionDefinitionId,
      ]);
      expect(events.map((e) => e.eventType)).not.toContain("EffectStepSkipped");
    });

    it("UT-R-SKL-08-006: LAST_ACTION_TARGETS resolves to the immediately preceding ACTION step's target, tracking any EffectAction kind (not only DAMAGE)", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const marker = markerAction("ACT_MARK", createMarkerId("MARKER_CURSE"));
      const followUp = damageAction("ACT_FOLLOW_UP");
      const effectActions = new Map([
        [marker.effectActionDefinitionId, marker],
        [followUp.effectActionDefinitionId, followUp],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, enemy.battleUnitId, marker.effectActionDefinitionId),
          deferredStep(1, {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "LAST_ACTION_TARGETS" },
            actions: [{ effectActionDefinitionId: followUp.effectActionDefinitionId }],
          }),
        ],
        targetUnitIds: [enemy.battleUnitId],
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      const actionStartings = events.filter((e) => e.eventType === "EffectActionStarting");
      expect(actionStartings.map((e) => e.payload.effectActionDefinitionId)).toEqual([
        marker.effectActionDefinitionId,
        followUp.effectActionDefinitionId,
      ]);
      expect(actionStartings[1]?.payload.targetUnitIds).toEqual([enemy.battleUnitId]);
    });

    it("UT-R-SKL-08-007: LAST_DAMAGED_TARGETS resolves to the target that actually received the preceding DAMAGE", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const attack = damageAction("ACT_ATTACK");
      const followUpMarker = markerAction("ACT_FOLLOW_UP_MARK", createMarkerId("MARKER_CURSE"));
      const effectActions = new Map([
        [attack.effectActionDefinitionId, attack],
        [followUpMarker.effectActionDefinitionId, followUpMarker],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const plan: EffectSequencePlan = {
        steps: [
          singleActionStep(0, true, enemy.battleUnitId, attack.effectActionDefinitionId),
          deferredStep(1, {
            kind: "ACTION",
            condition: { kind: "TRUE" },
            target: { kind: "LAST_DAMAGED_TARGETS" },
            actions: [{ effectActionDefinitionId: followUpMarker.effectActionDefinitionId }],
          }),
        ],
        targetUnitIds: [enemy.battleUnitId],
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      const markerApplied = events.find((e) => e.eventType === "MarkerApplied") as Extract<
        BattleDomainEvent,
        { eventType: "MarkerApplied" }
      >;
      expect(markerApplied.targetUnitIds).toEqual([enemy.battleUnitId]);
    });

    it("UT-R-SKL-08-008 (boundary, PR #216レビュー[P1]): an ACTION step whose target resolves to zero units still records a confirmed 'no target' last result, so a following LAST_RESULT-gated step observes it instead of seeing a stale result or throwing", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const noTargetAttack = damageAction("ACT_NO_TARGET");
      const followUpAttack = damageAction("ACT_FOLLOW_UP");
      const effectActions = new Map([
        [noTargetAttack.effectActionDefinitionId, noTargetAttack],
        [followUpAttack.effectActionDefinitionId, followUpAttack],
      ]);
      const { recorder, rootEventId } = seedRecorder();
      const context = contextFor(actor, effectActions, recorder, rootEventId);
      const tgtEmpty = createTargetBindingId("TGT_EMPTY");
      const tgtEnemy = createTargetBindingId("TGT_ENEMY");
      const noTargetStep: EffectStepDefinition = {
        kind: "ACTION",
        condition: { kind: "TRUE" },
        target: { kind: "BINDING", targetBindingId: tgtEmpty },
        actions: [{ effectActionDefinitionId: noTargetAttack.effectActionDefinitionId }],
      };
      const followUpStep: EffectStepDefinition = {
        kind: "ACTION",
        condition: { kind: "LAST_RESULT", field: "resultKind", op: "EQ", value: "SKIPPED" },
        target: { kind: "BINDING", targetBindingId: tgtEnemy },
        actions: [{ effectActionDefinitionId: followUpAttack.effectActionDefinitionId }],
      };
      const resolvedBindings = new Map<TargetBindingId, ResolvedBinding>([
        [tgtEmpty, { units: [], includeDefeated: false }],
        [tgtEnemy, { units: [enemy], includeDefeated: false }],
      ]);
      const plan: EffectSequencePlan = {
        steps: [deferredStep(0, noTargetStep), deferredStep(1, followUpStep)],
        targetUnitIds: [enemy.battleUnitId],
        resolvedBindings,
      };

      applyEffectActionGroups(plan, [actor, enemy], context);

      const events = recorder.getEvents();
      // Neither step's own condition was false, so EffectStepSkipped never fires;
      // the "no target" step-0 just has zero applications.
      expect(events.map((e) => e.eventType)).not.toContain("EffectStepSkipped");
      const actionStartings = events.filter((e) => e.eventType === "EffectActionStarting");
      // Only followUpStep actually applies (noTargetStep resolved zero
      // applications, so it never reaches resolveOneEffectActionApplication).
      expect(actionStartings).toHaveLength(1);
      expect(actionStartings[0]?.payload.effectActionDefinitionId).toBe(
        followUpAttack.effectActionDefinitionId,
      );
    });
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
      };

      const result = applyEffectActionGroups(plan, [actor, defeatedEnemy], context);

      // Not skipped: the hit reached HitConfirmed/DamageCalculated/DamageApplied
      // instead of being silently dropped by the target-already-defeated check.
      const emitted = recorder.getEvents().map((e) => e.eventType);
      expect(emitted).toContain("HitConfirmed");
      expect(emitted).toContain("DamageCalculated");
      expect(emitted).toContain("DamageApplied");
      expect(result.resolvedCount).toBe(1);
      expect(result.interruptedCount).toBe(0);

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
});
