import { describe, expect, it } from "vitest";
import { calculateCombatStat } from "./combat-stat-calculator.js";
import { createPercentage } from "../../shared/percentage.js";
import type { StatEffect } from "./effect-stacking-policy.js";

const ZERO = createPercentage(0);

describe("calculateCombatStat — R-STA-01 基本式", () => {
  it("UT-R-STA-04-001: with every correction at zero, the combat stat equals the base value", () => {
    const result = calculateCombatStat({
      stat: "ATTACK",
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
      stat: "ATTACK",
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
      stat: "ATTACK",
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
      stat: "ATTACK",
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
      stat: "ATTACK",
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
      stat: "ATTACK",
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
      stat: "ATTACK",
      baseValue: 200,
      formationBonus: createPercentage(0.1),
      aptitudePenalty: ZERO,
      fixedCorrection: 0,
    } as const;

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
      stat: "ATTACK",
      baseValue: 200,
      formationBonus: ZERO,
      aptitudePenalty: ZERO,
      fixedCorrection: 0,
    } as const;
    const withDebuff = calculateCombatStat({
      ...base,
      ratioEffects: [{ stacking: "STACKABLE", value: -0.3 }],
    });
    const afterExpiry = calculateCombatStat({ ...base, ratioEffects: [] });

    expect(withDebuff).toBeCloseTo(140);
    expect(afterExpiry).toBeCloseTo(200);
  });
});

describe("calculateCombatStat — R-STA-01 パーセントポイント加算ステータス", () => {
  // テーブルは配列リテラルのまま置く — `UT-TRACEABILITY-005` の静的走査は
  // `it.each` のテーブルを配列リテラルとしてしか解決できず、変数参照にすると
  // 実行対象と見なされずtestCaseIdが台帳から見えなくなる。
  it.each(["CRITICAL_RATE", "CRITICAL_DAMAGE_BONUS", "AFFINITY_BONUS"] as const)(
    "UT-R-STA-01-020: %s adds the formation bonus as percentage points instead of multiplying it",
    (stat) => {
      const result = calculateCombatStat({
        stat,
        baseValue: 0.2,
        formationBonus: createPercentage(0.15),
        aptitudePenalty: ZERO,
        ratioEffects: [],
        fixedCorrection: 0,
      });

      // 0.2 + 0.15 = 0.35 (R-BON-03のクレバー会心率+15%)。乗算なら 0.2 × 1.15 = 0.23。
      expect(result).toBeCloseTo(0.35);
    },
  );

  it.each(["CRITICAL_RATE", "CRITICAL_DAMAGE_BONUS", "AFFINITY_BONUS"] as const)(
    "UT-R-STA-01-021: %s adds in-combat corrections as percentage points, so stacked debuffs can drive it negative",
    (stat) => {
      const result = calculateCombatStat({
        stat,
        baseValue: 0.2,
        formationBonus: ZERO,
        aptitudePenalty: ZERO,
        ratioEffects: [],
        // 生駒葵の「高揚」3個ぶんの会心率-25pp（R-CRT-01のmax(0%, …)が実効0%へ切り上げる）。
        fixedCorrection: -0.75,
      });

      expect(result).toBeCloseTo(-0.55);
    },
  );

  it("UT-R-STA-01-022: percentage-point stats sum formation bonus, in-combat corrections and fixed corrections in one addition", () => {
    const result = calculateCombatStat({
      stat: "CRITICAL_RATE",
      baseValue: 0.2,
      formationBonus: createPercentage(0.15),
      aptitudePenalty: ZERO,
      ratioEffects: [
        { stacking: "STACKABLE", value: 0.025 },
        { stacking: "STACKABLE", value: 0.025 },
      ],
      fixedCorrection: -0.02,
    });

    // 0.2 + 0.15 + 0.05 - 0.02 = 0.38
    expect(result).toBeCloseTo(0.38);
  });

  it("UT-R-STA-01-023: the aptitude penalty never reaches percentage-point stats (R-STA-01 applies it to HP/attack/defense only)", () => {
    const result = calculateCombatStat({
      stat: "CRITICAL_RATE",
      baseValue: 0.2,
      formationBonus: ZERO,
      // resolveAptitudePenaltyは会心率へ0しか返さないが、渡されても式へ入らないことを固定する。
      aptitudePenalty: createPercentage(0.05),
      ratioEffects: [],
      fixedCorrection: 0,
    });

    expect(result).toBeCloseTo(0.2);
  });

  it.each(["MAXIMUM_HP", "ATTACK", "DEFENSE", "ACTION_SPEED"] as const)(
    "UT-R-STA-01-024: %s keeps the multiplicative formula unchanged",
    (stat) => {
      const result = calculateCombatStat({
        stat,
        baseValue: 100,
        formationBonus: createPercentage(0.25),
        aptitudePenalty: ZERO,
        ratioEffects: [{ stacking: "STACKABLE", value: 0.1 }],
        fixedCorrection: 50,
      });

      // 100 × (1 + 0.25) × (1 + 0.1) + 50 = 187.5
      expect(result).toBeCloseTo(187.5);
    },
  );
});
