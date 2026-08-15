import { describe, expect, it } from "vitest";
import {
  applyEffectActionGroups,
  type EffectActionGroupContext,
} from "./effect-action-group-resolver.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { applyMarker } from "../effects/marker-apply-service.js";
import { shieldPoolsOf } from "../combat/shield-policy.js";
import { subUnitDurabilityTotal } from "../combat/sub-unit-policy.js";
import {
  effectKindKeyFromDefinitionId,
  SUBUNIT_PROVIDER_ATTACK_KEY,
  type AppliedEffect,
} from "../model/applied-effect.js";
import type { MarkerState } from "../model/marker-state.js";
import { resolveSkillOrder, type EffectSequencePlan } from "../skill/skill-resolution-service.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { BattleDomainEvent } from "../events/domain-event.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createEffectInstanceId, createMarkerInstanceId } from "../../shared/event-ids.js";
import type { TargetSelectorDefinition } from "../../catalog/definitions/target-selector-definition.js";
import {
  createEffectActionDefinitionId,
  createMarkerId,
  createSkillDefinitionId,
  createTargetBindingId,
} from "../../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { EffectStepDefinition } from "../../catalog/definitions/effect-sequence.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  unit,
  damageAction,
  statModAction,
  markerAction,
  removeMarkerAction,
  cooldownManipulationAction,
  skillOf,
  contextFor,
  seedRecorder,
  singleActionStep,
  expectCompleted,
  expectInterrupted,
  deferredStep,
  actionOn,
} from "../../../testing/fixtures/effect-sequence-plan.js";

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
              targetUnitId: actor.battleUnitId,
              effectActionDefinitionId: selfHit.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetUnitId: actor.battleUnitId,
                  effectActionDefinitionId: selfHit.effectActionDefinitionId,
                  hitIndex: 1,
                },
              ],
            },
            {
              targetUnitId: enemy.battleUnitId,
              effectActionDefinitionId: otherHit.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetUnitId: enemy.battleUnitId,
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

  it("EffectActionCompleted.parentEventId (DAMAGE) points to the actual last event (DamageApplied), not EffectActionStarting", () => {
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

  it("EffectActionCompleted.parentEventId (DAMAGE, lethal) points to UnitDefeated when the hit is lethal", () => {
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

  it("EffectActionCompleted.parentEventId (COOLDOWN_MANIPULATION) points to the actual last event (CooldownCompleted), not EffectActionStarting", () => {
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
          sourceUnitId: createBattleUnitId("SOURCE"),
          targetUnitId: createBattleUnitId("ACTOR"),
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
          sourceUnitId: createBattleUnitId("SOURCE"),
          targetUnitId: createBattleUnitId("ACTOR"),
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

    it("UT-R-ACTN-01-002B: APPLY_MARKER rejects a context that has neither an actor BattleUnit nor a Memory source side, instead of granting a MarkerState with no recorded granter", () => {
      const actor = unit("ACTOR", "ALLY");
      const enemy = unit("ENEMY", "ENEMY");
      const markerId = createMarkerId("MARKER_TEST");
      const apply = markerAction("ACT_APPLY_MARKER", markerId);
      const effectActions = new Map([[apply.effectActionDefinitionId, apply]]);
      const { recorder, rootEventId } = seedRecorder();
      // R-EFF-10「直近の付与者」はexactly-one（`MarkerSource`）。実経路では
      // スキル解決が`actorUnitId`を、Memory解決（R-MEM-04）が`sourceSide`を必ず持つが、
      // 型だけでは両方欠落を防げないためこの境界で決定的に拒否する。
      const { actorUnitId: _actorId, ...withoutSource } = contextFor(
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
          sourceUnitId: actor.battleUnitId,
          targetUnitId: enemy.battleUnitId,
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

    it("UT-R-ACTN-01-006: APPLY_STAT_MOD still applies to an already-defeated target when its TargetSelectorDefinition.includeDefeated is true (explicit override)", () => {
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

    it("UT-R-ACTN-01-010: DAMAGE against an already-defeated target still applies through the real pipeline (applyDamageAction) when TargetSelectorDefinition.includeDefeated is true", () => {
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
          sourceUnitId: actor.battleUnitId,
          targetUnitId: enemy.battleUnitId,
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

  describe("R-TGT-10: TargetBinding sequence-start fixation (Issue #168)", () => {
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
              targetUnitId: target.battleUnitId,
              effectActionDefinitionId: attack.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetUnitId: target.battleUnitId,
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

    it("UT-R-SKL-08-013: a zero-target ACTION step with multiple actions records the definition-order-last action as the synthetic SKIPPED last-result, not the first", () => {
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
      actorUnitId: BattleUnit["battleUnitId"],
    ): NonNullable<EffectActionGroupContext["onFactEventForPassiveChain"]> {
      return (event, units) => {
        if (event.eventType !== eventType) {
          return units;
        }
        return units.map((u) => (u.battleUnitId === actorUnitId ? { ...u, currentHp: 0 } : u));
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

    it("UT-R-SKL-INT-007: unresolvedEffectCount counts remaining hits for a multi-hit DAMAGE application, not remaining applications", () => {
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
                targetUnitId: actor.battleUnitId,
                effectActionDefinitionId: tripleSelfHit.effectActionDefinitionId,
                includeDefeated: false,
                hits: [1, 2, 3].map((hitIndex) => ({
                  targetUnitId: actor.battleUnitId,
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

  describe("CAP_EFFECT_STEP_CONDITION（Issue #171 RES-004後半）: 対象別条件は実行時の最新状態で評価する", () => {
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
                    sourceUnitId: actor.battleUnitId,
                    targetUnitId: u.battleUnitId,
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

    it("UT-R-SKL-06-024: a self-referencing condition is never evaluated (and its actions never started) once EffectStepStarting's own chain has defeated the actor — INTERRUPTED with unresolvedEffectCount: 0", () => {
      const actor = unit("ACTOR", "ALLY");
      const markerId = createMarkerId("MARKER_TEST");
      // Both enemies already hold the marker before the step even starts, so
      // the self-referencing condition would match both if it were (wrongly)
      // evaluated — proving the actor-defeated short-circuit, not an
      // otherwise-empty match, is why no application happens.
      const markerState = (owner: BattleUnit): MarkerState => ({
        markerInstanceId: createMarkerInstanceId("MARKER_INSTANCE_1"),
        markerId,
        sourceUnitId: actor.battleUnitId,
        targetUnitId: owner.battleUnitId,
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

    it("UT-R-SKL-06-039: an ACTION step's own (non-self-referencing) TARGET_SET_COUNT condition is re-evaluated after its own EffectStepStarting's PS-style chain empties the referenced set, not before it is emitted", () => {
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
     * Issue #230: `UT-R-SKL-06-040`〜`043`はいずれもトップ
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

  describe("BRANCH step-wide TARGET_STATE/TARGET_HAS_MARKER via resolveTargetSet (Issue #230): a BRANCH condition referencing a guaranteed single-unit TargetReference (SELF/TRIGGER_SOURCE/count:1 BINDING) now resolves instead of throwing (previously `resolveBranchStep` always passed `targetContext: undefined`, so any such condition threw `DomainValidationError`)", () => {
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
      sourceUnitId: createBattleUnitId("HOLDER"),
      targetUnitId: createBattleUnitId("HOLDER"),
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
      sourceUnitId: holder.battleUnitId,
      targetUnitId: holder.battleUnitId,
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
      sourceUnitId: holder.battleUnitId,
      targetUnitId: holder.battleUnitId,
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
      sourceUnitId: holder.battleUnitId,
      targetUnitId: holder.battleUnitId,
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
      sourceUnitId: holder.battleUnitId,
      targetUnitId: holder.battleUnitId,
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

  it("UT-R-EFF-03-018: a pre-existing SPECIFIC_EFFECT immunity targeting an EFFECT_IMMUNITY definition rejects granting that immunity instead of always succeeding", () => {
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

  it("UT-R-EFF-07-014 (R-EFF-07 通知粒度): EffectConsumptionChanged reaches the PS/Memory chain before the next hit, even when the consumption does not reach 0 (no expiry step)", () => {
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
          sourceUnitId: createBattleUnitId("ENEMY"),
          targetUnitId: createBattleUnitId("ENEMY"),
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
              targetUnitId: enemy.battleUnitId,
              effectActionDefinitionId: attack.effectActionDefinitionId,
              includeDefeated: false,
              hits: [
                {
                  targetUnitId: enemy.battleUnitId,
                  effectActionDefinitionId: attack.effectActionDefinitionId,
                  hitIndex: 1,
                },
                {
                  targetUnitId: enemy.battleUnitId,
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

  it("UT-R-EFF-07-015 (R-EFF-07 通知粒度): consumes matching instances one at a time — the first EffectConsumptionChanged watcher still sees the second instance untouched, and removing it there skips its consumption instead of crashing", () => {
    const actor = unit("ACTOR", "ALLY");
    const attack = damageAction("ACT_ONE_HIT", 1);
    const consumptionDefId = createEffectActionDefinitionId("ACT_INCOMING_HIT_BUFF");
    const consumptionEffect = (id: string): AppliedEffect => ({
      effectInstanceId: createEffectInstanceId(id),
      effectActionDefinitionId: consumptionDefId,
      kindKey: effectKindKeyFromDefinitionId(consumptionDefId),
      duplicate: true,
      sourceUnitId: createBattleUnitId("ENEMY"),
      targetUnitId: createBattleUnitId("ENEMY"),
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
          sourceUnitId: createBattleUnitId("ENEMY"),
          targetUnitId: createBattleUnitId("ENEMY"),
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
