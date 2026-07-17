import { describe, expect, it } from "vitest";
import { resolvePassiveChain, type PassiveActivationOutcome } from "./resolve-passive-chain.js";
import { createEmptyPassiveActivationGuard, hasActivated } from "./passive-activation-guard.js";
import type { PassiveCandidate, PassiveCandidateGroup } from "./passive-candidate.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import type { BattleUnitId } from "../../shared/ids.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const POSITION = { column: "LEFT", row: "FRONT" } as const;
const GENEROUS_LIMITS = { maxPassiveDepth: 10, maxEffectsPerScope: 10 };

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

const NO_OP_OUTCOME: PassiveActivationOutcome = { generatedEvents: [], interrupted: false };

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
      activate: (candidate) => {
        order.push(candidate.skillDefinition.skillDefinitionId);
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          return { generatedEvents: [eventFromA], interrupted: false };
        }
        if (candidate.skillDefinition.skillDefinitionId === skillB.skillDefinitionId) {
          return { generatedEvents: [eventFromB], interrupted: false };
        }
        return NO_OP_OUTCOME;
      },
      limits: GENEROUS_LIMITS,
    });

    expect(order).toEqual(["SKL_A", "SKL_B", "SKL_C", "SKL_D"]);
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
      activate: (candidate) => {
        activatedSkillIds.push(candidate.skillDefinition.skillDefinitionId);
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          return { generatedEvents: [eventFromA], interrupted: false };
        }
        return NO_OP_OUTCOME;
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
        return NO_OP_OUTCOME;
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
      activate: () => ({ generatedEvents: [event("NEXT")], interrupted: false }),
      limits: { maxPassiveDepth: 3, maxEffectsPerScope: 100 },
    });

    expect(result).toEqual({ ok: false, reason: "MAX_PASSIVE_DEPTH_EXCEEDED" });
  });

  it("UT-GUARD-006: too many flat candidates in one scope stop with a structured MAX_EFFECTS_PER_SCOPE_EXCEEDED result", () => {
    const owner = unit("A");
    const flatGroup = [1, 2, 3, 4, 5].map((n) => candidateOf(owner, skillOf(`SKL_${n}`)));

    const result = resolvePassiveChain(event("ROOT"), createEmptyPassiveActivationGuard(), {
      detectCandidates: () => flatGroup,
      getCurrentUnit: () => owner,
      activate: () => NO_OP_OUTCOME,
      limits: { maxPassiveDepth: 10, maxEffectsPerScope: 3 },
    });

    expect(result).toEqual({ ok: false, reason: "MAX_EFFECTS_PER_SCOPE_EXCEEDED" });
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
      activate: (candidate) => {
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          return { generatedEvents: [], interrupted: true };
        }
        return NO_OP_OUTCOME;
      },
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
      activate: (candidate) => {
        activatedSkillIds.push(candidate.skillDefinition.skillDefinitionId);
        if (candidate.skillDefinition.skillDefinitionId === skillA.skillDefinitionId) {
          unitD = { ...unitD, currentHp: 0 };
          return { generatedEvents: [eventFromA], interrupted: false };
        }
        return NO_OP_OUTCOME;
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
});
