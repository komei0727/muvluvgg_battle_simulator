import { describe, expect, it } from "vitest";
import { calculateDamage, type DamageCalculationInput } from "./damage-calculator.js";
import { DomainValidationError } from "../shared/errors.js";

function input(overrides: Partial<DamageCalculationInput> = {}): DamageCalculationInput {
  return {
    attackerAttack: 50,
    attackerAttribute: "AGGRESSIVE",
    attackerAffinityBonus: 0,
    defenderDefense: 20,
    defenderAttribute: "AGGRESSIVE",
    defenseIgnoreRate: 0,
    skillPowerFormula: { kind: "SKILL_POWER", power: 1 },
    damageModifiers: [],
    criticalMultiplier: 1,
    ...overrides,
  };
}

describe("calculateDamage", () => {
  it("UT-R-DMG-01-001: base damage is attack minus defense, scaled by skill power", () => {
    expect(calculateDamage(input())).toBe(30);
  });

  it("UT-R-DMG-01-002: SKILL_POWER formula scales the base damage", () => {
    expect(calculateDamage(input({ skillPowerFormula: { kind: "SKILL_POWER", power: 1.5 } }))).toBe(
      45,
    );
  });

  it("UT-R-DMG-01-003: a favorable attribute applies 125% plus the attacker's affinity bonus (R-ATR-02)", () => {
    // AGGRESSIVE is favorable against SHY.
    const result = calculateDamage(
      input({
        attackerAttribute: "AGGRESSIVE",
        defenderAttribute: "SHY",
        attackerAffinityBonus: 0.1,
      }),
    );
    expect(result).toBe(Math.floor(30 * 1.35));
  });

  it("UT-R-DMG-01-004: a non-favorable attribute never applies the affinity bonus", () => {
    // AGGRESSIVE is only favorable against SHY, not against another AGGRESSIVE.
    const result = calculateDamage(
      input({
        attackerAttribute: "AGGRESSIVE",
        defenderAttribute: "AGGRESSIVE",
        attackerAffinityBonus: 0.5,
      }),
    );
    expect(result).toBe(30);
  });

  it("UT-R-DMG-01-005: defenseIgnoreRate reduces the effective defense before subtraction", () => {
    const result = calculateDamage(
      input({ attackerAttack: 50, defenderDefense: 40, defenseIgnoreRate: 0.5 }),
    );
    // effective defense = 40 * (1 - 0.5) = 20; base damage = 50 - 20 = 30
    expect(result).toBe(30);
  });

  it("UT-R-DMG-01-006: the resolved critical multiplier scales the final damage", () => {
    expect(calculateDamage(input({ criticalMultiplier: 2 }))).toBe(60);
  });

  it("UT-DAMAGE-CALCULATOR-001 (R-DMG-02 finalization, partial): the final result truncates any fractional part", () => {
    const result = calculateDamage(
      input({ skillPowerFormula: { kind: "SKILL_POWER", power: 1.03 } }),
    );
    // 30 * 1.03 = 30.9 -> floor -> 30
    expect(result).toBe(30);
  });

  it("UT-DAMAGE-CALCULATOR-002 (R-DMG-02 finalization, partial): attack at or below defense still deals a minimum of 1 damage", () => {
    expect(calculateDamage(input({ attackerAttack: 10, defenderDefense: 20 }))).toBe(1);
    expect(calculateDamage(input({ attackerAttack: 20, defenderDefense: 20 }))).toBe(1);
  });

  it("UT-DAMAGE-CALCULATOR-003: throws for a skill power formula kind other than SKILL_POWER (general FormulaEvaluator is M7 scope)", () => {
    expect(() =>
      calculateDamage(input({ skillPowerFormula: { kind: "CONSTANT", value: 10 } })),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-CALCULATOR-004: throws for a non-empty damageModifiers list (requires FormulaEvaluator/AppliedEffect, M7 scope)", () => {
    expect(() =>
      calculateDamage(input({ damageModifiers: [{ kind: "CONSTANT", value: 0.1 }] })),
    ).toThrow(DomainValidationError);
  });
});
