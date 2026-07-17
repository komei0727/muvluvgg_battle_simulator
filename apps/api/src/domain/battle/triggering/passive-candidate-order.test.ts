import { describe, expect, it } from "vitest";
import { comparePassiveCandidates, sortPassiveCandidates } from "./passive-candidate-order.js";
import type { PassiveCandidate } from "./passive-candidate.js";
import { createBattleUnit, type BattleUnit } from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import {
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import type { Side } from "../../shared/side.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";

const LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  position: FormationPosition,
  actionSpeed: number,
): BattleUnit {
  const member: BattlePartyMember = {
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

function skillOf(id: string, priorityAttack = false): SkillDefinition {
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
    resolution: { kind: "IMMEDIATE", targetBindings: [], steps: [] },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: "Test PS", tags: [] },
  };
}

function candidate(
  battleUnit: BattleUnit,
  skill: SkillDefinition,
  definitionIndex = 0,
): PassiveCandidate {
  const trigger = skill.triggers[0];
  if (trigger === undefined) {
    throw new Error("test skill must declare at least one trigger");
  }
  return { unit: battleUnit, skillDefinition: skill, trigger, definitionIndex };
}

describe("comparePassiveCandidates", () => {
  it("UT-R-PS-08-001: a preemptive-strike candidate sorts before a normal candidate regardless of speed", () => {
    const fastNormal = candidate(
      unit("FAST", "ALLY", { column: "LEFT", row: "FRONT" }, 99),
      skillOf("SKL_NORMAL", false),
    );
    const slowPreemptive = candidate(
      unit("SLOW", "ALLY", { column: "LEFT", row: "FRONT" }, 1),
      skillOf("SKL_PREEMPTIVE", true),
    );
    expect(comparePassiveCandidates(slowPreemptive, fastNormal)).toBeLessThan(0);
    expect(comparePassiveCandidates(fastNormal, slowPreemptive)).toBeGreaterThan(0);
  });

  it("UT-R-PS-08-002: among preemptive candidates, R-PS-02 (speed) breaks the tie", () => {
    const fastPreemptive = candidate(
      unit("FAST", "ALLY", { column: "LEFT", row: "FRONT" }, 20),
      skillOf("SKL_A", true),
    );
    const slowPreemptive = candidate(
      unit("SLOW", "ALLY", { column: "LEFT", row: "FRONT" }, 10),
      skillOf("SKL_B", true),
    );
    expect(comparePassiveCandidates(fastPreemptive, slowPreemptive)).toBeLessThan(0);
  });

  it("UT-R-PS-02-001: higher action speed sorts first", () => {
    const fast = candidate(
      unit("FAST", "ALLY", { column: "LEFT", row: "FRONT" }, 20),
      skillOf("SKL_A"),
    );
    const slow = candidate(
      unit("SLOW", "ALLY", { column: "LEFT", row: "FRONT" }, 10),
      skillOf("SKL_B"),
    );
    expect(comparePassiveCandidates(fast, slow)).toBeLessThan(0);
  });

  it("UT-R-PS-02-002: same speed sorts ALLY before ENEMY", () => {
    const ally = candidate(
      unit("A", "ALLY", { column: "LEFT", row: "FRONT" }, 10),
      skillOf("SKL_A"),
    );
    const enemy = candidate(
      unit("E", "ENEMY", { column: "LEFT", row: "FRONT" }, 10),
      skillOf("SKL_B"),
    );
    expect(comparePassiveCandidates(ally, enemy)).toBeLessThan(0);
  });

  it("UT-R-PS-02-003: same speed and side sorts FRONT before BACK", () => {
    const front = candidate(
      unit("F", "ALLY", { column: "LEFT", row: "FRONT" }, 10),
      skillOf("SKL_A"),
    );
    const back = candidate(
      unit("B", "ALLY", { column: "LEFT", row: "BACK" }, 10),
      skillOf("SKL_B"),
    );
    expect(comparePassiveCandidates(front, back)).toBeLessThan(0);
  });

  it("UT-R-PS-02-004: same speed, side, row sorts by absolute left-to-right column", () => {
    const left = candidate(
      unit("L", "ALLY", { column: "LEFT", row: "FRONT" }, 10),
      skillOf("SKL_A"),
    );
    const right = candidate(
      unit("R", "ALLY", { column: "RIGHT", row: "FRONT" }, 10),
      skillOf("SKL_B"),
    );
    expect(comparePassiveCandidates(left, right)).toBeLessThan(0);
  });

  it("UT-R-PS-02-005: fully tied candidates on the same unit break the tie by PS definition order", () => {
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, 10);
    const first = candidate(owner, skillOf("SKL_A"), 0);
    const second = candidate(owner, skillOf("SKL_B"), 1);
    expect(comparePassiveCandidates(first, second)).toBeLessThan(0);
    expect(comparePassiveCandidates(second, first)).toBeGreaterThan(0);
  });
});

describe("sortPassiveCandidates", () => {
  it("UT-R-PS-02-006 / UT-R-PS-08-003: full ordering does not depend on input array order", () => {
    const owner = unit("OWNER", "ALLY", { column: "LEFT", row: "FRONT" }, 10);
    const preemptive = candidate(
      unit("PRE", "ALLY", { column: "RIGHT", row: "BACK" }, 1),
      skillOf("SKL_PRE", true),
    );
    const fastAlly = candidate(
      unit("FAST_ALLY", "ALLY", { column: "LEFT", row: "FRONT" }, 20),
      skillOf("SKL_FAST"),
    );
    const slowEnemy = candidate(
      unit("SLOW_ENEMY", "ENEMY", { column: "LEFT", row: "FRONT" }, 5),
      skillOf("SKL_SLOW"),
    );
    const ownerFirst = candidate(owner, skillOf("SKL_OWNER_0"), 0);
    const ownerSecond = candidate(owner, skillOf("SKL_OWNER_1"), 1);

    const shuffled = [ownerSecond, slowEnemy, fastAlly, ownerFirst, preemptive];
    const reversed = [...shuffled].reverse();

    const expected = [preemptive, fastAlly, ownerFirst, ownerSecond, slowEnemy];
    expect(sortPassiveCandidates(shuffled)).toEqual(expected);
    expect(sortPassiveCandidates(reversed)).toEqual(expected);
  });
});
