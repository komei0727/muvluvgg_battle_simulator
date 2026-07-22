import { describe, expect, it } from "vitest";
import {
  resolvePassiveChain,
  type PassiveActivation,
  type PassiveActivationCompletion,
  type PassiveActivationStep,
  type PassiveChainDependencies,
} from "./resolve-passive-chain.js";
import { createEmptyPassiveActivationGuard, hasActivated } from "./passive-activation-guard.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleId, createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { EventRecorder } from "../events/event-recorder.js";
import type { DomainEventId } from "../../shared/event-ids.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const POSITION = { column: "LEFT", row: "FRONT" } as const;
const GENEROUS_LIMITS = {
  maxPassiveDepth: 10,
  maxEffectsPerScope: 10,
  maxEffectRuntimeCounterDepth: 10,
};

function unit(id: string): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position: POSITION,
    globalCoordinate: toGlobalCoordinate("ALLY", POSITION),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return { ...createBattleUnit(member, "ALLY", LIMITS), currentPp: 3 };
}

interface SkillOverrides {
  readonly simultaneousActivationLimited?: boolean;
  readonly exclusiveActivationGroupId?: string | null;
}

function skillOf(id: string, overrides: SkillOverrides = {}): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "PS",
    cost: { resource: "PP", amount: 1 },
    activationCondition: { kind: "TRUE" },
    triggers: [
      {
        eventType: "ANY",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
        condition: { kind: "TRUE" },
      },
    ],
    counterUpdates: [],
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: overrides.simultaneousActivationLimited ?? false,
      exclusiveActivationGroupId: overrides.exclusiveActivationGroupId ?? null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Test PS", tags: [] },
  };
}

function candidateOf(battleUnit: BattleUnit, skill: SkillDefinition): PassiveCandidate {
  const trigger = skill.triggers[0];
  if (trigger === undefined) {
    throw new Error("test skill must declare at least one trigger");
  }
  return { unit: battleUnit, skillDefinition: skill, trigger, definitionIndex: 0 };
}

function event(eventType: string): TriggerCandidateEvent {
  return { eventType, category: "FACT", payload: {} };
}

const DONE: PassiveActivationCompletion = { interrupted: false };

/** A resolved-effect step carrying the (possibly empty) events it produced. */
function resolvedStep(events: readonly TriggerCandidateEvent[] = []): PassiveActivationStep {
  return { kind: "EFFECT_RESOLVED", events };
}

/** A pre-application TIMING step (uncounted by the effects guard). */
function timingStep(triggerEvent: TriggerCandidateEvent): PassiveActivationStep {
  return { kind: "TIMING_EVENT", event: triggerEvent };
}

/**
 * Builds a `PassiveActivation` that completes immediately without yielding any
 * step. Implemented as a plain iterator rather than `function*` because
 * `eslint(require-yield)` rejects a generator function whose body never
 * yields, and several fakes below legitimately model a PS with zero effects.
 */
function completedActivation(completion: PassiveActivationCompletion): PassiveActivation {
  let done = false;
  return {
    next: () => {
      if (done) {
        throw new Error("completedActivation generator already consumed");
      }
      done = true;
      return { done: true, value: completion };
    },
  };
}

describe("resolvePassiveChain", () => {
  it("UT-R-PS-06-007 / SCN-BTL-007: a 3+ stage immediate chain resolves depth-first and returns to the parent group for its remaining candidate", () => {
    const unitA = unit("A");
    const unitB = unit("B");
    const unitC = unit("C");
    const unitD = unit("D");
    const skillA = skillOf("SKL_A");
    const skillB = skillOf("SKL_B");
    const skillC = skillOf("SKL_C");
    const skillD = skillOf("SKL_D");
    const candA = candidateOf(unitA, skillA);
    const candB = candidateOf(unitB, skillB);
    const candC = candidateOf(unitC, skillC);
    const candD = candidateOf(unitD, skillD);

    const order: string[] = [];
    // Records which event each candidate was actually activated against, so this
    // test also proves per-level causality: a nested candidate must be threaded
    // through the specific event that produced it, not the root event.
    const seenEvents: Record<string, TriggerCandidateEvent> = {};
    const units = new Map<BattleUnitId, BattleUnit>([
      [unitA.battleUnitId, unitA],
      [unitB.battleUnitId, unitB],
      [unitC.battleUnitId, unitC],
      [unitD.battleUnitId, unitD],
    ]);

    const rootEvent = event("ROOT");
    const eventFromA = event("FROM_A");
    const eventFromB = event("FROM_B");

    const groupsByEvent = new Map<string, PassiveCandidateGroup>([
      [rootEvent.eventType, [candA, candD]],
      [eventFromA.eventType, [candB]],
      [eventFromB.eventType, [candC]],
    ]);

    const result = resolvePassiveChain(rootEvent, createEmptyPassiveActivationGuard(), {
      detectCandidates: (evt) => groupsByEvent.get(evt.eventType) ?? [],
      getCurrentUnit: (id) => {
        const found = units.get(id);
        if (found === undefined) {
          throw new Error(`unknown unit ${id}`);
        }
        return found;
      },
      activate: function* (candidate, evt) {
        order.push(candidate.skillDefinition.skillDefinitionId);
        seenEvents[candidate.skillDefinition.skillDefinitionId] = evt;
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          yield resolvedStep([eventFromA]);
        } else if (candidate.skillDefinition.skillDefinitionId === skillB.skillDefinitionId) {
          yield resolvedStep([eventFromB]);
        } else {
          yield resolvedStep();
        }
        return DONE;
      },
      limits: GENEROUS_LIMITS,
    });

    expect(order).toEqual(["SKL_A", "SKL_B", "SKL_C", "SKL_D"]);
    expect(seenEvents.SKL_A).toBe(rootEvent);
    expect(seenEvents.SKL_B).toBe(eventFromA);
    expect(seenEvents.SKL_C).toBe(eventFromB);
    expect(seenEvents.SKL_D).toBe(rootEvent);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        hasActivated(result.activationGuard, unitA.battleUnitId, skillA.skillDefinitionId),
      ).toBe(true);
      expect(
        hasActivated(result.activationGuard, unitD.battleUnitId, skillD.skillDefinitionId),
      ).toBe(true);
    }
  });

  it("UT-R-PS-06-008: a child PS triggered mid-EffectSequence resolves before the parent's remaining effects, not after the parent completes", () => {
    // Reproduces the parent-effect-A -> child-PS -> parent-effect-B ordering
    // that a real EffectSequence resolver (#73) will drive through this port:
    // the parent's own generator must not be allowed to reach effect B until
    // the child PS chain triggered by effect A has fully resolved.
    const unitParent = unit("PARENT");
    const unitChild = unit("CHILD");
    const skillParent = skillOf("SKL_PARENT");
    const skillChild = skillOf("SKL_CHILD");
    const candParent = candidateOf(unitParent, skillParent);
    const candChild = candidateOf(unitChild, skillChild);

    const order: string[] = [];
    const rootEvent = event("ROOT");
    const effectAEvent = event("EFFECT_A");
    const effectBEvent = event("EFFECT_B");

    const groupsByEvent = new Map<string, PassiveCandidateGroup>([
      [rootEvent.eventType, [candParent]],
      [effectAEvent.eventType, [candChild]],
      [effectBEvent.eventType, []],
    ]);

    const result = resolvePassiveChain(rootEvent, createEmptyPassiveActivationGuard(), {
      detectCandidates: (evt) => groupsByEvent.get(evt.eventType) ?? [],
      getCurrentUnit: (id) => (id === unitParent.battleUnitId ? unitParent : unitChild),
      activate: function* (candidate) {
        if (candidate.skillDefinition.skillDefinitionId === skillParent.skillDefinitionId) {
          order.push("PARENT_EFFECT_A");
          yield resolvedStep([effectAEvent]);
          order.push("PARENT_EFFECT_B");
          yield resolvedStep([effectBEvent]);
          order.push("PARENT_DONE");
          return DONE;
        }
        order.push("CHILD_ACTIVATED");
        return DONE;
      },
      limits: GENEROUS_LIMITS,
    });

    expect(order).toEqual(["PARENT_EFFECT_A", "CHILD_ACTIVATED", "PARENT_EFFECT_B", "PARENT_DONE"]);
    expect(result.ok).toBe(true);
  });

  it("UT-R-PS-07-001: the same BattleUnit + PS is not activated twice within one resolution scope, even if a naive detector re-surfaces it", () => {
    const unitA = unit("A");
    const unitB = unit("B");
    const skillA = skillOf("SKL_A");
    const skillB = skillOf("SKL_B");
    const candA = candidateOf(unitA, skillA);
    const candB = candidateOf(unitB, skillB);

    const activatedSkillIds: string[] = [];
    const rootEvent = event("ROOT");
    const eventFromA = event("FROM_A");
    const groupsByEvent = new Map<string, PassiveCandidateGroup>([
      [rootEvent.eventType, [candA]],
      // Deliberately re-surfaces candA (simulating a detector that has not filtered
      // already-activated PS) alongside a genuinely new candB.
      [eventFromA.eventType, [candA, candB]],
    ]);

    const result = resolvePassiveChain(rootEvent, createEmptyPassiveActivationGuard(), {
      detectCandidates: (evt) => groupsByEvent.get(evt.eventType) ?? [],
      getCurrentUnit: (id) => (id === unitA.battleUnitId ? unitA : unitB),
      activate: function* (candidate) {
        activatedSkillIds.push(candidate.skillDefinition.skillDefinitionId);
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          yield resolvedStep([eventFromA]);
        }
        return DONE;
      },
      limits: GENEROUS_LIMITS,
    });

    expect(activatedSkillIds).toEqual(["SKL_A", "SKL_B"]);
    expect(result.ok).toBe(true);
  });

  it("UT-R-PS-03-007: exclusiveActivationGroupId candidates detected together only activate one", () => {
    const unitA = unit("A");
    const unitB = unit("B");
    const skillA = skillOf("SKL_A", { exclusiveActivationGroupId: "GROUP_1" });
    const skillB = skillOf("SKL_B", { exclusiveActivationGroupId: "GROUP_1" });
    const candA = candidateOf(unitA, skillA);
    const candB = candidateOf(unitB, skillB);

    const activatedSkillIds: string[] = [];
    const rootEvent = event("ROOT");

    const result = resolvePassiveChain(rootEvent, createEmptyPassiveActivationGuard(), {
      detectCandidates: () => [candA, candB],
      getCurrentUnit: (id) => (id === unitA.battleUnitId ? unitA : unitB),
      activate: (candidate) => {
        activatedSkillIds.push(candidate.skillDefinition.skillDefinitionId);
        return completedActivation(DONE);
      },
      limits: GENEROUS_LIMITS,
    });

    expect(activatedSkillIds).toEqual(["SKL_A"]);
    expect(result.ok).toBe(true);
  });

  it("UT-GUARD-005: an ever-deepening chain stops with a structured MAX_PASSIVE_DEPTH_EXCEEDED result", () => {
    const owner = unit("A");
    let counter = 0;

    const result = resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
      // Each detected candidate targets a distinct fresh skill id so R-PS-07 never
      // blocks re-activation; only the depth guard can stop this ever-deepening chain.
      detectCandidates: () => {
        counter += 1;
        return [candidateOf(owner, skillOf(`SKL_${counter}`))];
      },
      getCurrentUnit: () => owner,
      activate: function* () {
        yield resolvedStep([event("NEXT")]);
        return DONE;
      },
      limits: { maxPassiveDepth: 3, maxEffectsPerScope: 1000, maxEffectRuntimeCounterDepth: 10 },
    });

    expect(result).toEqual({ ok: false, reason: "MAX_PASSIVE_DEPTH_EXCEEDED" });
  });

  it("UT-GUARD-006: too many resolved effects in one scope stop with a structured MAX_EFFECTS_PER_SCOPE_EXCEEDED result, counted per effect rather than per PS activation", () => {
    const owner = unit("A");
    // A single PS candidate whose own EffectSequence resolves 5 effects (5
    // yielded steps), none of which trigger further PS candidates. The old
    // (buggy) design counted one "effect" per PS activation and would never
    // have caught this.
    const skill = skillOf("SKL_MANY_EFFECTS");
    const candidate = candidateOf(owner, skill);

    const result = resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
      detectCandidates: (evt) => (evt.eventType === "ROOT" ? [candidate] : []),
      getCurrentUnit: () => owner,
      activate: function* () {
        for (let i = 0; i < 5; i += 1) {
          yield resolvedStep();
        }
        return DONE;
      },
      limits: { maxPassiveDepth: 10, maxEffectsPerScope: 3, maxEffectRuntimeCounterDepth: 10 },
    });

    expect(result).toEqual({ ok: false, reason: "MAX_EFFECTS_PER_SCOPE_EXCEEDED" });
  });

  it("UT-GUARD-007: post-application domain events from a single EffectAction are each checked for PS candidates but counted as exactly one resolved effect", () => {
    // Mirrors a real damage EffectAction: DamageCalculated and DamageApplied
    // (FACT category, post-application) are bundled into the same resolved
    // step, so they are each checked for PS candidates but counted as exactly
    // one resolved effect.
    const owner = unit("A");
    const candidate = candidateOf(owner, skillOf("SKL_MULTI_EVENT"));
    const detectedEventTypes: string[] = [];
    const postApplicationEvents = [event("DamageCalculated"), event("DamageApplied")];

    function run(limits: PassiveChainDependencies["limits"]) {
      return resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
        detectCandidates: (evt) => {
          detectedEventTypes.push(evt.eventType);
          return evt.eventType === "ROOT" ? [candidate] : [];
        },
        getCurrentUnit: () => owner,
        activate: function* () {
          yield resolvedStep(postApplicationEvents);
          return DONE;
        },
        limits,
      });
    }

    expect(
      run({ maxPassiveDepth: 10, maxEffectsPerScope: 1, maxEffectRuntimeCounterDepth: 10 }).ok,
    ).toBe(true);
    expect(
      run({ maxPassiveDepth: 10, maxEffectsPerScope: 0, maxEffectRuntimeCounterDepth: 10 }),
    ).toEqual({
      ok: false,
      reason: "MAX_EFFECTS_PER_SCOPE_EXCEEDED",
    });
    expect(detectedEventTypes).toEqual(
      expect.arrayContaining(postApplicationEvents.map((e) => e.eventType)),
    );
  });

  it("UT-GUARD-008: a recursive PS-triggers-PS chain (each effect immediately triggering the next PS) still stops with MAX_EFFECTS_PER_SCOPE_EXCEEDED, not just the depth guard", () => {
    // Regression for a real bug: when the effect-resolved count was only
    // incremented on a *later* yield than the one carrying the triggering
    // event, a chain where every PS's single effect immediately triggers the
    // next PS never reached that later yield (each activation paused to
    // resolve its child before advancing its own generator), so the count
    // stayed at 0 no matter how deep the chain went and only the (much
    // higher, differently-purposed) depth guard could ever stop it. Counting
    // must happen atomically when a step is yielded, before recursing into
    // the events it produced.
    const owner = unit("A");
    let counter = 0;

    const result = resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
      detectCandidates: () => {
        counter += 1;
        return [candidateOf(owner, skillOf(`SKL_${counter}`))];
      },
      getCurrentUnit: () => owner,
      activate: function* () {
        yield resolvedStep([event("NEXT")]);
        return DONE;
      },
      // Depth is generous; only the effects guard should be able to stop this.
      limits: { maxPassiveDepth: 1000, maxEffectsPerScope: 3, maxEffectRuntimeCounterDepth: 10 },
    });

    expect(result).toEqual({ ok: false, reason: "MAX_EFFECTS_PER_SCOPE_EXCEEDED" });
  });

  it("UT-GUARD-009: a pre-application TIMING event lets a reactive PS cancel the EffectAction, which is then not counted as a resolved effect", () => {
    // Models EffectActionStarting (a TIMING event per 08_ドメインイベント.md):
    // a reactive PS (e.g. an evade/shield PS) intervenes before the attacking
    // EffectAction resolves, and the attacker's generator observes this and
    // decides not to resolve/count the cancelled action at all (no
    // EFFECT_RESOLVED step is yielded for it). Only the reactive PS's own
    // effect should be counted.
    const attacker = unit("ATTACKER");
    const defender = unit("DEFENDER");
    const skillAttack = skillOf("SKL_ATTACK");
    const skillEvade = skillOf("SKL_EVADE");
    const candAttack = candidateOf(attacker, skillAttack);
    const candEvade = candidateOf(defender, skillEvade);

    const rootEvent = event("ROOT");
    const startingEvent = event("EffectActionStarting");
    const activatedSkillIds: string[] = [];

    function run(limits: PassiveChainDependencies["limits"]) {
      return resolvePassiveChain(rootEvent, createEmptyPassiveActivationGuard(), {
        detectCandidates: (evt) => {
          if (evt.eventType === rootEvent.eventType) {
            return [candAttack];
          }
          if (evt.eventType === startingEvent.eventType) {
            return [candEvade];
          }
          return [];
        },
        getCurrentUnit: (id) => (id === attacker.battleUnitId ? attacker : defender),
        activate: function* (candidate) {
          activatedSkillIds.push(candidate.skillDefinition.skillDefinitionId);
          if (candidate.skillDefinition.skillDefinitionId === skillAttack.skillDefinitionId) {
            yield timingStep(startingEvent);
            // The reactive evade PS (resolved above, synchronously, before this
            // generator resumes) cancelled this EffectAction: it never resolves,
            // so no EFFECT_RESOLVED step is yielded for it at all.
            return DONE;
          }
          // The reactive evade PS resolves its own single effect.
          yield resolvedStep();
          return DONE;
        },
        limits,
      });
    }

    // If the cancelled attack were (incorrectly) counted, this generous-but-tight
    // limit of exactly 1 would be exceeded by the evade PS's own effect.
    expect(
      run({ maxPassiveDepth: 10, maxEffectsPerScope: 1, maxEffectRuntimeCounterDepth: 10 }).ok,
    ).toBe(true);
    // If the evade PS's own effect were (incorrectly) never counted at all, this
    // zero limit would not trip.
    expect(
      run({ maxPassiveDepth: 10, maxEffectsPerScope: 0, maxEffectRuntimeCounterDepth: 10 }),
    ).toEqual({
      ok: false,
      reason: "MAX_EFFECTS_PER_SCOPE_EXCEEDED",
    });
    expect(activatedSkillIds).toEqual(
      expect.arrayContaining([skillAttack.skillDefinitionId, skillEvade.skillDefinitionId]),
    );
  });

  it("UT-R-PS-05-001: an interrupted activation is surfaced without aborting the rest of the chain", () => {
    const unitA = unit("A");
    const unitB = unit("B");
    const skillA = skillOf("SKL_A");
    const skillB = skillOf("SKL_B");
    const candA = candidateOf(unitA, skillA);
    const candB = candidateOf(unitB, skillB);

    const result = resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
      detectCandidates: () => [candA, candB],
      getCurrentUnit: (id) => (id === unitA.battleUnitId ? unitA : unitB),
      activate: (candidate) =>
        completedActivation(
          candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId
            ? { interrupted: true }
            : DONE,
        ),
      limits: GENEROUS_LIMITS,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.interruptedCandidates).toEqual([{ ...candA, unit: unitA }]);
      expect(
        hasActivated(result.activationGuard, unitB.battleUnitId, skillB.skillDefinitionId),
      ).toBe(true);
    }
  });

  it("UT-R-PS-04-009: parent re-verification discards a remaining parent candidate whose owner was defeated by a nested chain", () => {
    const unitA = unit("A");
    let unitD = unit("D");
    const skillA = skillOf("SKL_A");
    const skillD = skillOf("SKL_D");
    const candA = candidateOf(unitA, skillA);
    const candD = candidateOf(unitD, skillD);

    const rootEvent = event("ROOT");
    const eventFromA = event("FROM_A");
    const activatedSkillIds: string[] = [];

    const result = resolvePassiveChain(rootEvent, createEmptyPassiveActivationGuard(), {
      detectCandidates: (evt) => (evt.eventType === rootEvent.eventType ? [candA, candD] : []),
      getCurrentUnit: (id) => (id === unitA.battleUnitId ? unitA : unitD),
      activate: function* (candidate) {
        activatedSkillIds.push(candidate.skillDefinition.skillDefinitionId);
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          unitD = { ...unitD, currentHp: 0 };
          yield resolvedStep([eventFromA]);
        }
        return DONE;
      },
      limits: GENEROUS_LIMITS,
    });

    expect(activatedSkillIds).toEqual(["SKL_A"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        hasActivated(result.activationGuard, candD.unit.battleUnitId, skillD.skillDefinitionId),
      ).toBe(false);
    }
  });

  it("UT-R-PS-04-011 (Issue #144, TRIGGER_EXCLUSION_TIMING): deps.resolutionPhase reaches reconfirmation, discarding a RESOLUTION_PHASE(negate: true)-gated candidate detected during that phase", () => {
    const unitA = unit("A");
    const skillA: SkillDefinition = {
      ...skillOf("SKL_A"),
      triggers: [
        {
          eventType: "ANY",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: { kind: "RESOLUTION_PHASE", phase: "TURN_START", negate: true },
        },
      ],
    };
    const candA = candidateOf(unitA, skillA);

    const excluded = resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
      detectCandidates: () => [candA],
      getCurrentUnit: () => unitA,
      activate: () => completedActivation(DONE),
      limits: GENEROUS_LIMITS,
      resolutionPhase: "TURN_START",
    });
    expect(excluded.ok).toBe(true);
    if (excluded.ok) {
      expect(
        hasActivated(excluded.activationGuard, unitA.battleUnitId, skillA.skillDefinitionId),
      ).toBe(false);
    }

    const includedDuringNormalAction = resolvePassiveChain(
      event("ROOT"),
      createEmptyPassiveActivationGuard(),
      {
        detectCandidates: () => [candA],
        getCurrentUnit: () => unitA,
        activate: () => completedActivation(DONE),
        limits: GENEROUS_LIMITS,
      },
    );
    expect(includedDuringNormalAction.ok).toBe(true);
    if (includedDuringNormalAction.ok) {
      expect(
        hasActivated(
          includedDuringNormalAction.activationGuard,
          unitA.battleUnitId,
          skillA.skillDefinitionId,
        ),
      ).toBe(true);
    }
  });

  it("UT-R-PS-04-012 (Issue #144 review fix [P2]): reconfirmation uses a separate findUnit lookup for POSITION_RELATION, deterministically discarding a candidate whose target no longer resolves instead of throwing (getCurrentUnit is reserved for owner lookups and throws on unknown ids in production)", () => {
    const unitA = unit("A");
    const skillA: SkillDefinition = {
      ...skillOf("SKL_A"),
      triggers: [
        {
          eventType: "ANY",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          condition: {
            kind: "POSITION_RELATION",
            target: { kind: "TRIGGER_TARGET" },
            relation: "IN_FRONT_OF",
          },
        },
      ],
    };
    const candA = candidateOf(unitA, skillA);
    const vanishedTargetId = createBattleUnitId("GONE");
    const rootEvent: TriggerCandidateEvent = {
      eventType: "ANY",
      category: "FACT",
      targetUnitIds: [vanishedTargetId],
      payload: {},
    };

    const result = resolvePassiveChain(rootEvent, createEmptyPassiveActivationGuard(), {
      detectCandidates: () => [candA],
      getCurrentUnit: (id) => {
        if (id === unitA.battleUnitId) {
          return unitA;
        }
        // Mirrors production `requireUnit`: throws on an unknown BattleUnitId.
        // POSITION_RELATION reconfirmation must never reach this lookup for a
        // vanished target — it must use `findUnit` instead.
        throw new Error(`unexpected getCurrentUnit(${id})`);
      },
      findUnit: () => undefined,
      activate: () => completedActivation(DONE),
      limits: GENEROUS_LIMITS,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        hasActivated(result.activationGuard, unitA.battleUnitId, skillA.skillDefinitionId),
      ).toBe(false);
    }
  });

  it("smoke: a candidate whose activation completes immediately generates no follow-ups", () => {
    const owner = unit("A");
    const candidate = candidateOf(owner, skillOf("SKL_A"));
    const result = resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
      detectCandidates: (evt) => (evt.eventType === "ROOT" ? [candidate] : []),
      getCurrentUnit: () => owner,
      activate: () => completedActivation(DONE),
      limits: GENEROUS_LIMITS,
    });
    expect(result.ok).toBe(true);
  });

  it("UT-R-PS-06-009: nested activations threaded through resolvePassiveChain record correct rootEventId/parentEventId/sequence in a real EventRecorder", () => {
    // Addresses the review request for causality verification against the real
    // event envelope (08_ドメインイベント.md), not just the minimal
    // TriggerCandidateEvent used for trigger matching. `resolvePassiveChain`
    // itself does not assign DomainEventId/sequence/parentEventId/rootEventId
    // (that is EventRecorder's job, wired by #73's real EffectSequence
    // resolver) — what it must get right is threading the correct "immediate
    // cause" event to each nested activate() call, which is exactly what a
    // real recorder needs as `parentEventId`. This test proves that by having
    // each fake `activate()` actually call the production `EventRecorder`.
    const recorder = new EventRecorder(createBattleId("BATTLE_1"));
    const scopeId = recorder.nextResolutionScopeId();
    const recordedEventIdOf = new Map<TriggerCandidateEvent, DomainEventId>();
    // `EventRecorder.record` defaults `rootEventId` to the event's own eventId
    // when omitted, so the root call below leaves it unset and every later call
    // explicitly threads that same id through, exactly as a real nested PS
    // activation must do.
    let rootEventId: DomainEventId | undefined;

    function recordAndWrap(causeEvent: TriggerCandidateEvent | undefined): TriggerCandidateEvent {
      const parentEventId =
        causeEvent === undefined ? undefined : recordedEventIdOf.get(causeEvent);
      const recorded = recorder.record({
        eventType: "TurnStarted",
        category: "FACT",
        turnNumber: 1,
        cycleNumber: 1,
        resolutionScopeId: scopeId,
        payload: { turnNumber: 1 },
        ...(parentEventId !== undefined ? { parentEventId } : {}),
        ...(rootEventId !== undefined ? { rootEventId } : {}),
      });
      rootEventId ??= recorded.eventId;
      // `recorded.category` widens to `domain-event.ts`'s `EventCategory` (now
      // includes DIAGNOSTIC, added for `ExtraGaugeOverflowDiscarded` in #34),
      // but this helper always records with `category: "FACT"` above, and
      // `TriggerCandidateEvent.category` intentionally stays FACT/TIMING-only
      // (DIAGNOSTIC events never trigger PS/Memory candidates).
      const triggerEvent: TriggerCandidateEvent = {
        eventType: recorded.eventType,
        category: "FACT",
        payload: {},
      };
      recordedEventIdOf.set(triggerEvent, recorded.eventId);
      return triggerEvent;
    }

    const unitA = unit("A");
    const unitB = unit("B");
    const unitC = unit("C");
    const skillA = skillOf("SKL_A");
    const skillB = skillOf("SKL_B");
    const skillC = skillOf("SKL_C");
    const candA = candidateOf(unitA, skillA);
    const candB = candidateOf(unitB, skillB);
    const candC = candidateOf(unitC, skillC);

    const rootTriggerEvent = recordAndWrap(undefined);
    const groupsByEvent = new Map<TriggerCandidateEvent, PassiveCandidateGroup>([
      [rootTriggerEvent, [candA]],
    ]);

    const result = resolvePassiveChain(rootTriggerEvent, createEmptyPassiveActivationGuard(), {
      detectCandidates: (evt) => groupsByEvent.get(evt) ?? [],
      getCurrentUnit: (id) => [unitA, unitB, unitC].find((u) => u.battleUnitId === id) ?? unitA,
      activate: function* (candidate, causeEvent) {
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          const effectFromA = recordAndWrap(causeEvent);
          groupsByEvent.set(effectFromA, [candB]);
          yield resolvedStep([effectFromA]);
        } else if (candidate.skillDefinition.skillDefinitionId === skillB.skillDefinitionId) {
          const effectFromB = recordAndWrap(causeEvent);
          groupsByEvent.set(effectFromB, [candC]);
          yield resolvedStep([effectFromB]);
        }
        return DONE;
      },
      limits: GENEROUS_LIMITS,
    });

    expect(result.ok).toBe(true);
    const recordedEvents = recorder.getEvents();
    expect(recordedEvents).toHaveLength(3);
    const [root, fromA, fromB] = recordedEvents;
    // rootEventId defaults to the event's own eventId when omitted (EventRecorder contract)
    // and every nested event must inherit that same root, not its own eventId.
    expect(root?.rootEventId).toBe(root?.eventId);
    expect(fromA?.rootEventId).toBe(root?.eventId);
    expect(fromB?.rootEventId).toBe(root?.eventId);
    expect(root?.parentEventId).toBeUndefined();
    expect(fromA?.parentEventId).toBe(root?.eventId);
    expect(fromB?.parentEventId).toBe(fromA?.eventId);
    // sequence reflects the actual (interleaved, depth-first) recording order.
    expect(root?.sequence).toBe(1);
    expect(fromA?.sequence).toBe(2);
    expect(fromB?.sequence).toBe(3);
  });
});
