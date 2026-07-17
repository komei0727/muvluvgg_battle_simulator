import { describe, expect, it } from "vitest";
import { calculateDamage, type DamageCalculationInput } from "./damage-calculator.js";
import { DomainValidationError } from "../../shared/errors.js";

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
    expect(calculateDamage(input()).finalDamage).toBe(30);
  });

  it("UT-R-DMG-01-002: SKILL_POWER formula scales the base damage", () => {
    expect(
      calculateDamage(input({ skillPowerFormula: { kind: "SKILL_POWER", power: 1.5 } }))
        .finalDamage,
    ).toBe(45);
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
    expect(result.finalDamage).toBe(Math.floor(30 * 1.35));
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
    expect(result.finalDamage).toBe(30);
  });

  it("UT-R-DMG-01-005: defenseIgnoreRate reduces the effective defense before subtraction", () => {
    const result = calculateDamage(
      input({ attackerAttack: 50, defenderDefense: 40, defenseIgnoreRate: 0.5 }),
    );
    // effective defense = 40 * (1 - 0.5) = 20; base damage = 50 - 20 = 30
    expect(result.finalDamage).toBe(30);
  });

  it("UT-R-DMG-01-006: the resolved critical multiplier scales the final damage", () => {
    expect(calculateDamage(input({ criticalMultiplier: 2 })).finalDamage).toBe(60);
  });

  it("UT-DAMAGE-CALCULATOR-001 (R-DMG-02 finalization, partial): the final result truncates any fractional part", () => {
    const result = calculateDamage(
      input({ skillPowerFormula: { kind: "SKILL_POWER", power: 1.03 } }),
    );
    // 30 * 1.03 = 30.9 -> floor -> 30
    expect(result.finalDamage).toBe(30);
  });

  it("UT-DAMAGE-CALCULATOR-002 (R-DMG-02 finalization, partial): attack at or below defense still deals a minimum of 1 damage", () => {
    expect(calculateDamage(input({ attackerAttack: 10, defenderDefense: 20 })).finalDamage).toBe(1);
    expect(calculateDamage(input({ attackerAttack: 20, defenderDefense: 20 })).finalDamage).toBe(1);
  });

  it("UT-DAMAGE-CALCULATOR-003: throws for a skill power formula kind other than SKILL_POWER (general FormulaEvaluator is M7 scope)", () => {
    expect(() =>
      calculateDamage(input({ skillPowerFormula: { kind: "CONSTANT", value: 10 } })),
    ).toThrow(DomainValidationError);
  });

  it("UT-R-DMG-01-007: damageModifiers sum as signed ratios into an Action内追加ダメージ倍率 of 1 + Σvalues", () => {
    const result = calculateDamage(
      input({
        damageModifiers: [
          { kind: "CONSTANT", value: 0.1 },
          { kind: "CONSTANT", value: 0.05 },
        ],
      }),
    );
    // 1 + 0.1 + 0.05 = 1.15; 30 * 1.15 = 34.5 -> floor -> 34
    expect(result.finalDamage).toBe(34);
  });

  it("UT-R-DMG-01-008: a damageModifiers sum below -100% clamps the Action内追加ダメージ倍率 to 0, not negative", () => {
    const result = calculateDamage(input({ damageModifiers: [{ kind: "CONSTANT", value: -1.5 }] }));
    // multiplier clamps to 0, so calculated damage is 0 — but the minimum-1-damage floor (R-DMG-02) still applies.
    expect(result.finalDamage).toBe(1);
  });

  it("UT-DAMAGE-CALCULATOR-004: throws when a damageModifiers entry is not a CONSTANT formula (general FormulaEvaluator is M7 scope)", () => {
    expect(() =>
      calculateDamage(input({ damageModifiers: [{ kind: "SKILL_POWER", power: 0.1 }] })),
    ).toThrow(DomainValidationError);
  });

  it("UT-DAMAGE-CALCULATOR-005 (会心・ダメージイベントの監査可能性): exposes effectiveDefense, the defenseIgnoreRate-adjusted defense used for the base damage subtraction", () => {
    const result = calculateDamage(
      input({ attackerAttack: 50, defenderDefense: 40, defenseIgnoreRate: 0.5 }),
    );
    expect(result.effectiveDefense).toBe(20);
  });

  it("UT-DAMAGE-CALCULATOR-006: exposes attributeMultiplier, the resolved attribute affinity multiplier", () => {
    const result = calculateDamage(
      input({
        attackerAttribute: "AGGRESSIVE",
        defenderAttribute: "SHY",
        attackerAffinityBonus: 0.1,
      }),
    );
    expect(result.attributeMultiplier).toBeCloseTo(1.35);
  });

  it("UT-DAMAGE-CALCULATOR-007: exposes actionDamageMultiplier, the resolved Action内追加ダメージ倍率", () => {
    const result = calculateDamage(input({ damageModifiers: [{ kind: "CONSTANT", value: 0.1 }] }));
    expect(result.actionDamageMultiplier).toBeCloseTo(1.1);
  });

  it("UT-DAMAGE-CALCULATOR-008: exposes preTruncationDamage, the calculated value before the final floor/minimum-1 clamp", () => {
    const result = calculateDamage(
      input({ skillPowerFormula: { kind: "SKILL_POWER", power: 1.03 } }),
    );
    // 30 * 1.03 = 30.9, truncated to 30 as finalDamage.
    expect(result.preTruncationDamage).toBeCloseTo(30.9);
    expect(result.finalDamage).toBe(30);
  });

  it("UT-DAMAGE-CALCULATOR-009: exposes skillPower, the resolved SKILL_POWER formula value", () => {
    const result = calculateDamage(
      input({ skillPowerFormula: { kind: "SKILL_POWER", power: 1.5 } }),
    );
    expect(result.skillPower).toBe(1.5);
  });
});
