import { describe, expect, it } from "vitest";
import { composeSkillPowerMultiplier } from "./skill-power-modifier-policy.js";
import {
  attackDamageBonusEffect,
  skillPowerModifierEffect,
} from "../../../testing/fixtures/damage-application.js";
import { testBattleUnit } from "../../../testing/fixtures/battle-actors.js";

function enemyActor(id: string) {
  return testBattleUnit({ battleUnitId: id, unitDefinitionId: "UNIT_E", side: "ENEMY" });
}

describe("composeSkillPowerMultiplier (R-DMG-08)", () => {
  it("UT-R-DMG-08-005: multiplies every held skill power modifier instead of adding them", () => {
    const attacker = {
      ...enemyActor("E1"),
      appliedEffects: [
        skillPowerModifierEffect("EF_1", "E1", -0.75),
        skillPowerModifierEffect("EF_2", "E1", -0.75),
      ],
    };
    expect(composeSkillPowerMultiplier(attacker)).toBeCloseTo(0.0625, 12);
  });

  it("UT-R-DMG-08-006: ignores effects that are not skill power modifiers", () => {
    const attacker = {
      ...enemyActor("E1"),
      appliedEffects: [attackDamageBonusEffect("EF_1", "E1", 0.5)],
    };
    expect(composeSkillPowerMultiplier(attacker)).toBe(1);
  });

  it("UT-R-DMG-08-007: clamps each factor at 0 so two strong reductions never flip the sign", () => {
    const attacker = {
      ...enemyActor("E1"),
      appliedEffects: [
        skillPowerModifierEffect("EF_1", "E1", -1.5),
        skillPowerModifierEffect("EF_2", "E1", -1.5),
      ],
    };
    expect(composeSkillPowerMultiplier(attacker)).toBe(0);
  });
});
