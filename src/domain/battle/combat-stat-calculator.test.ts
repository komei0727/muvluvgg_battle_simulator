import { describe, expect, it } from "vitest";
import { calculateCombatStat } from "./combat-stat-calculator.js";
import { createPercentage } from "./percentage.js";
import type { StatEffect } from "./effect-stacking-policy.js";

const ZERO = createPercentage(0);

describe("calculateCombatStat — R-STA-01 基本式", () => {
  it("UT-R-STA-04-001: with every correction at zero, the combat stat equals the base value", () => {
    const result = calculateCombatStat({
      baseValue: 100,
      formationBonus: ZERO,
      aptitudePenalty: ZERO,
      ratioEffects: [],
      fixedCorrection: 0,
    });
    expect(result).toBeCloseTo(100);
  });

  it("UT-R-STA-04-002: formation bonus and aptitude penalty multiply the base value together before ratio corrections", () => {
    const result = calculateCombatStat({
      baseValue: 100,
      formationBonus: createPercentage(0.25),
      aptitudePenalty: createPercentage(0.05),
      ratioEffects: [],
      fixedCorrection: 0,
    });
    // 100 * (1 + 0.25 - 0.05) = 120
    expect(result).toBeCloseTo(120);
  });

  it("UT-R-STA-04-003: ratio effects (buffs/debuffs) apply as a second, independent multiplier", () => {
    const ratioEffects: StatEffect[] = [{ stacking: "STACKABLE", value: 0.1 }];
    const result = calculateCombatStat({
      baseValue: 100,
      formationBonus: createPercentage(0.25),
      aptitudePenalty: createPercentage(0.05),
      ratioEffects,
      fixedCorrection: 0,
    });
    // 100 * (1 + 0.25 - 0.05) * (1 + 0.1) = 132
    expect(result).toBeCloseTo(132);
  });

  it("UT-R-STA-04-004: the Memory fixed correction is added last, after every multiplier", () => {
    const result = calculateCombatStat({
      baseValue: 100,
      formationBonus: createPercentage(0.25),
      aptitudePenalty: createPercentage(0.05),
      ratioEffects: [{ stacking: "STACKABLE", value: 0.1 }],
      fixedCorrection: 50,
    });
    // 132 + 50 = 182
    expect(result).toBeCloseTo(182);
  });

  it("UT-R-STA-04-005: a negative ratio correction can bring the stat below the base value", () => {
    const result = calculateCombatStat({
      baseValue: 100,
      formationBonus: ZERO,
      aptitudePenalty: ZERO,
      ratioEffects: [{ stacking: "STACKABLE", value: -0.5 }],
      fixedCorrection: 0,
    });
    expect(result).toBeCloseTo(50);
  });

  it("UT-R-STA-04-006: intermediate results are not truncated (only final HP/AP/PP/EX application truncates, per R-NUM-02)", () => {
    const result = calculateCombatStat({
      baseValue: 3,
      formationBonus: createPercentage(0.1),
      aptitudePenalty: ZERO,
      ratioEffects: [],
      fixedCorrection: 0,
    });
    expect(result).toBeCloseTo(3.3);
  });
});

describe("calculateCombatStat — R-STA-04 再計算", () => {
  it("UT-R-STA-04-007: recalculating with an updated effect list (buff added) reuses the same pure function and reflects the change", () => {
    const base = {
      baseValue: 200,
      formationBonus: createPercentage(0.1),
      aptitudePenalty: ZERO,
      fixedCorrection: 0,
    };

    const before = calculateCombatStat({ ...base, ratioEffects: [] });
    const after = calculateCombatStat({
      ...base,
      ratioEffects: [{ stacking: "STACKABLE", value: 0.2 }],
    });

    expect(before).toBeCloseTo(220);
    expect(after).toBeCloseTo(264);
    expect(after).not.toBeCloseTo(before, 0);
  });

  it("UT-R-STA-04-008: recalculating after a debuff expires (removed from the list) restores the prior value", () => {
    const base = {
      baseValue: 200,
      formationBonus: ZERO,
      aptitudePenalty: ZERO,
      fixedCorrection: 0,
    };
    const withDebuff = calculateCombatStat({
      ...base,
      ratioEffects: [{ stacking: "STACKABLE", value: -0.3 }],
    });
    const afterExpiry = calculateCombatStat({ ...base, ratioEffects: [] });

    expect(withDebuff).toBeCloseTo(140);
    expect(afterExpiry).toBeCloseTo(200);
  });
});
