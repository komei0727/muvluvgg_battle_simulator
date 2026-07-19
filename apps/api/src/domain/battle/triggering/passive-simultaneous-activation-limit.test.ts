import { describe, expect, it } from "vitest";
import { applySimultaneousActivationLimit } from "./passive-simultaneous-activation-limit.js";
import type { PassiveCandidate } from "./passive-candidate.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { Side } from "../../shared/side.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };
const POSITION = { column: "LEFT", row: "FRONT" } as const;

function unit(id: string, side: Side): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
    attribute: "AGGRESSIVE",
    position: POSITION,
    globalCoordinate: toGlobalCoordinate(side, POSITION),
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
  return createBattleUnit(member, side, LIMITS);
}

interface SkillOverrides {
  readonly priorityAttack?: boolean;
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
        eventType: "TurnStarted",
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
      priorityAttack: overrides.priorityAttack ?? false,
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

describe("applySimultaneousActivationLimit", () => {
  it("UT-R-PS-03-001: candidates without any limiting trait all stay kept", () => {
    const a = candidateOf(unit("A", "ALLY"), skillOf("SKL_A"));
    const b = candidateOf(unit("B", "ALLY"), skillOf("SKL_B"));
    expect(applySimultaneousActivationLimit([a, b])).toEqual({ kept: [a, b], suppressed: [] });
  });

  it("UT-R-PS-03-002: among simultaneousActivationLimited candidates, only the highest-ranked (first, per R-PS-02 order) one stays", () => {
    const first = candidateOf(
      unit("FIRST", "ALLY"),
      skillOf("SKL_FIRST", { simultaneousActivationLimited: true }),
    );
    const second = candidateOf(
      unit("SECOND", "ALLY"),
      skillOf("SKL_SECOND", { simultaneousActivationLimited: true }),
    );
    const unrelated = candidateOf(unit("OTHER", "ALLY"), skillOf("SKL_OTHER"));
    expect(applySimultaneousActivationLimit([first, second, unrelated])).toEqual({
      kept: [first, unrelated],
      suppressed: [second],
    });
  });

  it("UT-R-PS-03-003: preemptive candidates already sort first, so a preemptive simultaneousActivationLimited candidate wins over a normal one", () => {
    const preemptive = candidateOf(
      unit("PRE", "ALLY"),
      skillOf("SKL_PRE", { priorityAttack: true, simultaneousActivationLimited: true }),
    );
    const normal = candidateOf(
      unit("NORMAL", "ALLY"),
      skillOf("SKL_NORMAL", { simultaneousActivationLimited: true }),
    );
    // Caller is expected to pass an already R-PS-02/R-PS-08-ordered group (e.g. sortPassiveCandidates output).
    expect(applySimultaneousActivationLimit([preemptive, normal])).toEqual({
      kept: [preemptive],
      suppressed: [normal],
    });
  });

  it("UT-R-PS-03-004: candidates sharing the same exclusiveActivationGroupId keep only the first, ranked one", () => {
    const first = candidateOf(
      unit("FIRST", "ALLY"),
      skillOf("SKL_FIRST", { exclusiveActivationGroupId: "GROUP_1" }),
    );
    const second = candidateOf(
      unit("SECOND", "ALLY"),
      skillOf("SKL_SECOND", { exclusiveActivationGroupId: "GROUP_1" }),
    );
    expect(applySimultaneousActivationLimit([first, second])).toEqual({
      kept: [first],
      suppressed: [second],
    });
  });

  it("UT-R-PS-03-005: distinct exclusiveActivationGroupId values are independent limit groups", () => {
    const groupOneWinner = candidateOf(
      unit("G1", "ALLY"),
      skillOf("SKL_G1", { exclusiveActivationGroupId: "GROUP_1" }),
    );
    const groupOneLoser = candidateOf(
      unit("G1B", "ALLY"),
      skillOf("SKL_G1B", { exclusiveActivationGroupId: "GROUP_1" }),
    );
    const groupTwoWinner = candidateOf(
      unit("G2", "ALLY"),
      skillOf("SKL_G2", { exclusiveActivationGroupId: "GROUP_2" }),
    );
    expect(
      applySimultaneousActivationLimit([groupOneWinner, groupOneLoser, groupTwoWinner]),
    ).toEqual({
      kept: [groupOneWinner, groupTwoWinner],
      suppressed: [groupOneLoser],
    });
  });

  it("UT-R-PS-03-006: a candidate that is both simultaneousActivationLimited and in a losing exclusive group is suppressed only once", () => {
    const winner = candidateOf(
      unit("WINNER", "ALLY"),
      skillOf("SKL_WINNER", {
        simultaneousActivationLimited: true,
        exclusiveActivationGroupId: "GROUP_1",
      }),
    );
    const loser = candidateOf(
      unit("LOSER", "ALLY"),
      skillOf("SKL_LOSER", {
        simultaneousActivationLimited: true,
        exclusiveActivationGroupId: "GROUP_1",
      }),
    );
    const result = applySimultaneousActivationLimit([winner, loser]);
    expect(result.kept).toEqual([winner]);
    expect(result.suppressed).toEqual([loser]);
  });
});
