import { describe, expect, it } from "vitest";
import { composeSkillPowerMultiplier, skillPowerBonusesOf } from "./skill-power-modifier-policy.js";
import {
  attackDamageBonusEffect,
  skillPowerBonusEffect,
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

describe("skillPowerBonusesOf (R-DMG-08)", () => {
  it("UT-R-DMG-08-018: lists every held skill power bonus in the order they were granted", () => {
    const attacker = {
      ...enemyActor("E1"),
      appliedEffects: [
        skillPowerBonusEffect("EF_1", "E1", 0.075),
        skillPowerBonusEffect("EF_2", "E1", 0.075),
        skillPowerBonusEffect("EF_3", "E1", -0.05),
      ],
    };
    // 合計はダメージ計算が威力と併せて10進で行う（R-NUM-02）ため、ここでは足さない。
    expect(skillPowerBonusesOf(attacker)).toEqual([0.075, 0.075, -0.05]);
  });

  it("UT-R-DMG-08-019 (negative): ignores multiplicative skill power modifiers and other effects", () => {
    const attacker = {
      ...enemyActor("E1"),
      appliedEffects: [
        skillPowerModifierEffect("EF_1", "E1", -0.75),
        attackDamageBonusEffect("EF_2", "E1", 0.5),
      ],
    };
    expect(skillPowerBonusesOf(attacker)).toEqual([]);
    // 加算値は乗算の倍率にも混ざらない。
    expect(
      composeSkillPowerMultiplier({
        ...enemyActor("E1"),
        appliedEffects: [skillPowerBonusEffect("EF_3", "E1", 0.075)],
      }),
    ).toBe(1);
  });
});
