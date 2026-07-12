import { describe, expect, it } from "vitest";
import { calculateStartingCombatStats } from "./starting-combat-stats.js";
import type { FormationBonus } from "./formation-bonus-calculator.js";
import { createPercentage } from "./percentage.js";
import type { BaseStats } from "../catalog/unit-definition.js";

const ZERO_BONUS: FormationBonus = {
  attackBonus: createPercentage(0),
  hpBonus: createPercentage(0),
  defenseBonus: createPercentage(0),
  criticalRateBonus: createPercentage(0),
};

const BASE_STATS: BaseStats = {
  maximumHp: 1000,
  attack: 200,
  defense: 100,
  criticalRate: 0.1,
  criticalDamageBonus: 0.5,
  affinityBonus: 0.25,
  actionSpeed: 50,
  maximumAp: 3,
  maximumPp: 3,
};

describe("calculateStartingCombatStats — R-STA-01 開始ステータス", () => {
  it("UT-R-STA-01-010: with no formation bonus and matching aptitude, combat stats equal base stats", () => {
    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
    });

    expect(result).toEqual({
      maximumHp: 1000,
      attack: 200,
      defense: 100,
      criticalRate: 0.1,
      actionSpeed: 50,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    });
  });

  it("UT-R-STA-01-011: formation bonus raises HP/attack/defense/criticalRate but never actionSpeed or criticalDamageBonus", () => {
    const bonus: FormationBonus = {
      attackBonus: createPercentage(0.25),
      hpBonus: createPercentage(0.25),
      defenseBonus: createPercentage(0.3),
      criticalRateBonus: createPercentage(0.15),
    };

    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: bonus,
    });

    expect(result.attack).toBeCloseTo(250);
    expect(result.maximumHp).toBeCloseTo(1250);
    expect(result.defense).toBeCloseTo(130);
    expect(result.criticalRate).toBeCloseTo(0.115);
    expect(result.actionSpeed).toBeCloseTo(50);
    expect(result.criticalDamageBonus).toBeCloseTo(0.5);
  });

  it("UT-R-STA-01-012: a mismatched row applies the 5% aptitude penalty to HP/attack/defense only", () => {
    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "BACK",
      formationBonus: ZERO_BONUS,
    });

    expect(result.maximumHp).toBeCloseTo(950);
    expect(result.attack).toBeCloseTo(190);
    expect(result.defense).toBeCloseTo(95);
    expect(result.criticalRate).toBeCloseTo(0.1);
    expect(result.actionSpeed).toBeCloseTo(50);
  });

  it("UT-R-ATR-02-004: affinityBonus is copied through as-is from baseStats, unaffected by formation/aptitude", () => {
    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "BACK",
      formationBonus: {
        attackBonus: createPercentage(0.25),
        hpBonus: createPercentage(0.25),
        defenseBonus: createPercentage(0.3),
        criticalRateBonus: createPercentage(0.15),
      },
    });

    expect(result.affinityBonus).toBeCloseTo(0.25);
  });

  it("UT-R-ATR-02-005: a per-unit overridden affinityBonus flows through as the base value", () => {
    const overriddenBaseStats: BaseStats = { ...BASE_STATS, affinityBonus: 0.4 };

    const result = calculateStartingCombatStats({
      baseStats: overriddenBaseStats,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
    });

    expect(result.affinityBonus).toBeCloseTo(0.4);
  });
});
