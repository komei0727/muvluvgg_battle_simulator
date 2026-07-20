import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "./effect-action-group-resolver.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import type { BattleDefinitions } from "../model/battle-definitions.js";
import type { EffectSequencePlan } from "../skill/skill-resolution-service.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createEffectActionDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
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

function statModAction(id: string, value = 10): EffectActionDefinition {
  return {
    kind: "APPLY_STAT_MOD",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      stat: "ATTACK",
      valueType: "FIXED",
      formula: { kind: "CONSTANT", value },
      stacking: { mode: "STACKABLE" },
      duration: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

function applyMarkerAction(id: string, markerId: string): EffectActionDefinition {
  return {
    kind: "APPLY_MARKER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      markerId: markerId as never,
      stack: { policy: "ADD", max: null },
      duration: { dispellable: true, linkedEffectGroupId: null },
    },
  };
}

function applyMarkerActionWithTurnDuration(id: string, markerId: string): EffectActionDefinition {
  return {
    kind: "APPLY_MARKER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: {
      markerId: markerId as never,
      stack: { policy: "ADD", max: null },
      duration: {
        timeLimit: { unit: "TURN", count: 2 },
        dispellable: true,
        linkedEffectGroupId: null,
      },
    },
  };
}

function removeMarkerAction(id: string, markerId: string): EffectActionDefinition {
  return {
    kind: "REMOVE_MARKER",
    effectActionDefinitionId: createEffectActionDefinitionId(id),
    requiredCapabilities: [],
    metadata: { tags: [] },
    payload: { markerId: markerId as never },
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

  it("Issue #23: APPLY_STAT_MOD grants an AppliedEffect and emits EffectApplied, resultKind APPLIED", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const buff = statModAction("ACT_BUFF", 15);
    const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, buff.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const targetAfter = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(targetAfter.appliedEffects).toHaveLength(1);
    expect(targetAfter.appliedEffects[0]?.magnitude).toBe(15);
    const applied = recorder.getEvents().find((e) => e.eventType === "EffectApplied");
    expect(applied?.payload).toMatchObject({
      sourceUnitId: actor.battleUnitId,
      targetUnitId: enemy.battleUnitId,
      magnitude: 15,
    });
    const completed = recorder
      .getEvents()
      .find((e) => e.eventType === "EffectActionCompleted") as Extract<
      BattleDomainEvent,
      { eventType: "EffectActionCompleted" }
    >;
    expect(completed.payload.resultKind).toBe("APPLIED");
  });

  it("Issue #23: APPLY_MARKER grants a Marker and emits MarkerApplied", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const mark = applyMarkerAction("ACT_MARK", "MARKER_WARNING_ROD");
    const effectActions = new Map([[mark.effectActionDefinitionId, mark]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, mark.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const targetAfter = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(targetAfter.markers).toHaveLength(1);
    expect(recorder.getEvents().some((e) => e.eventType === "MarkerApplied")).toBe(true);
  });

  it("Issue #23: REMOVE_MARKER removes an existing Marker and emits MarkerRemoved", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemyId = createBattleUnitId("ENEMY");
    const enemy = unit("ENEMY", "ENEMY", {
      markers: [
        {
          markerId: "MARKER_WARNING_ROD" as never,
          sourceId: actor.battleUnitId,
          targetId: enemyId,
          stackCount: 1,
          stackMax: null,
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      ],
    });
    const remove = removeMarkerAction("ACT_UNMARK", "MARKER_WARNING_ROD");
    const effectActions = new Map([[remove.effectActionDefinitionId, remove]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, remove.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const targetAfter = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    expect(targetAfter.markers).toEqual([]);
    expect(recorder.getEvents().some((e) => e.eventType === "MarkerRemoved")).toBe(true);
  });

  it("PR #155 re-review [P1]: APPLY_STAT_MOD's EffectApplied (and EffectiveEffectChanged, if any) reach onFactEventForPassiveChain on the normal AS/EX path, not just the internal generic capture", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const buff = statModAction("ACT_BUFF", 15);
    const effectActions = new Map([[buff.effectActionDefinitionId, buff]]);
    const { recorder, rootEventId } = seedRecorder();
    const observedEventTypes: string[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observedEventTypes.push(event.eventType);
      return units;
    });
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, buff.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(observedEventTypes).toContain("EffectApplied");
  });

  it("PR #155 re-review [P1]: APPLY_MARKER's MarkerApplied reaches onFactEventForPassiveChain on the normal AS/EX path", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const mark = applyMarkerAction("ACT_MARK", "MARKER_WARNING_ROD");
    const effectActions = new Map([[mark.effectActionDefinitionId, mark]]);
    const { recorder, rootEventId } = seedRecorder();
    const observedEventTypes: string[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observedEventTypes.push(event.eventType);
      return units;
    });
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, mark.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(observedEventTypes).toContain("MarkerApplied");
  });

  it("PR #155 re-review [P1]: REMOVE_MARKER's MarkerRemoved reaches onFactEventForPassiveChain on the normal AS/EX path", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemyId = createBattleUnitId("ENEMY");
    const enemy = unit("ENEMY", "ENEMY", {
      markers: [
        {
          markerId: "MARKER_WARNING_ROD" as never,
          sourceId: actor.battleUnitId,
          targetId: enemyId,
          stackCount: 1,
          stackMax: null,
          duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
          dispellable: true,
          linkedEffectGroupId: null,
        },
      ],
    });
    const remove = removeMarkerAction("ACT_UNMARK", "MARKER_WARNING_ROD");
    const effectActions = new Map([[remove.effectActionDefinitionId, remove]]);
    const { recorder, rootEventId } = seedRecorder();
    const observedEventTypes: string[] = [];
    const context = contextFor(actor, effectActions, recorder, rootEventId, (event, units) => {
      observedEventTypes.push(event.eventType);
      return units;
    });
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, remove.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    applyEffectActionGroups(plan, [actor, enemy], context);

    expect(observedEventTypes).toContain("MarkerRemoved");
  });

  it("PR #155 re-review [P1]: APPLY_MARKER with a TURN-unit duration initializes timeLimitRemaining/grantedTurnNumber, not just the bare definition", () => {
    const actor = unit("ACTOR", "ALLY");
    const enemy = unit("ENEMY", "ENEMY");
    const mark = applyMarkerActionWithTurnDuration("ACT_MARK", "MARKER_WARNING_ROD");
    const effectActions = new Map([[mark.effectActionDefinitionId, mark]]);
    const { recorder, rootEventId } = seedRecorder();
    const context = contextFor(actor, effectActions, recorder, rootEventId);
    const plan: EffectSequencePlan = {
      steps: [singleActionStep(0, true, enemy.battleUnitId, mark.effectActionDefinitionId)],
      targetUnitIds: [enemy.battleUnitId],
    };

    const result = applyEffectActionGroups(plan, [actor, enemy], context);

    const targetAfter = result.units.find((u) => u.battleUnitId === enemy.battleUnitId)!;
    const grantedMarker = targetAfter.markers[0];
    expect(grantedMarker?.duration.timeLimitRemaining).toBe(2);
    expect(grantedMarker?.duration.grantedTurnNumber).toBe(1);
  });
});
