import { describe, expect, it } from "vitest";
import { isExUsable, selectAsCandidate } from "./action-selection-policy.js";
import { createBattleUnit, type BattleUnit, type BattleUnitResourceLimits } from "./battle-unit.js";
import type { BattlePartyMember } from "./battle-party.js";
import { createBattleUnitId } from "../shared/ids.js";
import {
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "../catalog/catalog-ids.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";
import type { SkillDefinition } from "../catalog/skill-definition.js";
import type { TargetSelectorDefinition } from "../catalog/target-selector-definition.js";
import { DomainValidationError } from "../shared/errors.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  position: FormationPosition,
  overrides: Partial<BattleUnit> = {},
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
      actionSpeed: 10,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return { ...createBattleUnit(member, side, LIMITS), ...overrides };
}

const ENEMY_SELECTOR: TargetSelectorDefinition = {
  kind: "SELECT",
  side: "ENEMY",
  count: 1,
  filters: [],
  order: ["DEFAULT"],
  includeDefeated: false,
};

function asSkill(
  id: string,
  apCost: number,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    skillDefinitionId: createSkillDefinitionId(id),
    skillType: "AS",
    cost: { resource: "AP", amount: apCost },
    activationCondition: { kind: "TRUE" },
    triggers: [],
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        { targetBindingId: createTargetBindingId("TGT_1"), selector: ENEMY_SELECTOR },
      ],
      steps: [],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {
      priorityAttack: false,
      simultaneousActivationLimited: false,
      exclusiveActivationGroupId: null,
      accuracy: { guaranteedHit: false },
      piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
    },
    requiredCapabilities: [],
    metadata: { displayName: id, tags: [] },
    ...overrides,
  };
}

describe("selectAsCandidate", () => {
  it("UT-R-ACT-02-001: selects the first AS in definition order that is usable", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" }, { currentAp: 3 });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const skillA = asSkill("SKL_A", 1);
    const skillB = asSkill("SKL_B", 1);

    const result = selectAsCandidate([skillA, skillB], actor, [actor, enemy]);

    expect(result).toEqual({ kind: "SKILL", skill: skillA });
  });

  it("UT-R-ACT-02-002: skips a skill whose AP cost exceeds the actor's current AP", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" }, { currentAp: 1 });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const tooExpensive = asSkill("SKL_EXPENSIVE", 2);
    const affordable = asSkill("SKL_CHEAP", 1);

    const result = selectAsCandidate([tooExpensive, affordable], actor, [actor, enemy]);

    expect(result).toEqual({ kind: "SKILL", skill: affordable });
  });

  it("UT-R-ACT-02-003 / SCN-BTL-006 partial: skips a skill with no resolvable target and selects the next candidate", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" }, { currentAp: 3 });
    // No ENEMY units at all: the enemy-target selector resolves to zero candidates.
    const noTarget = asSkill("SKL_NO_TARGET", 1);
    const usable = asSkill("SKL_USABLE", 1, {
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: [],
      },
    });

    const result = selectAsCandidate([noTarget, usable], actor, [actor]);

    expect(result).toEqual({ kind: "SKILL", skill: usable });
  });

  it("UT-R-ACT-02-004: waits when no AS candidate is usable", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" }, { currentAp: 3 });
    const noTarget = asSkill("SKL_NO_TARGET", 1);

    const result = selectAsCandidate([noTarget], actor, [actor]);

    expect(result).toEqual({ kind: "WAIT" });
  });

  it("UT-R-ACT-02-005: waits when there are no AS candidates at all", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" }, { currentAp: 3 });

    const result = selectAsCandidate([], actor, [actor]);

    expect(result).toEqual({ kind: "WAIT" });
  });

  it("UT-ACTION-SELECTION-POLICY-001: throws for an unsupported activationCondition kind (ConditionEvaluator is M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" }, { currentAp: 3 });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const conditional = asSkill("SKL_CONDITIONAL", 1, {
      activationCondition: { kind: "MARKER_PRESENT", markerId: "MARKER_X" } as never,
    });

    expect(() => selectAsCandidate([conditional], actor, [actor, enemy])).toThrow(
      DomainValidationError,
    );
  });
});

describe("isExUsable", () => {
  it("UT-R-ACT-01-EX-001: usable when the EX skill has at least one resolvable target", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const exSkill = asSkill("SKL_EX", 0);

    expect(isExUsable(exSkill, actor, [actor, enemy])).toBe(true);
  });

  it("UT-R-ACT-01-EX-002 (Q-BTL-06): unusable when the EX skill has no resolvable target", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const exSkill = asSkill("SKL_EX", 0);

    expect(isExUsable(exSkill, actor, [actor])).toBe(false);
  });

  it("UT-R-ACT-01-EX-003: throws for an unsupported activationCondition kind (ConditionEvaluator is M7 scope)", () => {
    const actor = unit("ACTOR", "ALLY", { column: "LEFT", row: "FRONT" });
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" });
    const exSkill = asSkill("SKL_EX", 0, {
      activationCondition: { kind: "MARKER_PRESENT", markerId: "MARKER_X" } as never,
    });

    expect(() => isExUsable(exSkill, actor, [actor, enemy])).toThrow(DomainValidationError);
  });
});
