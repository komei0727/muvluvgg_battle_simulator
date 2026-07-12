import { describe, expect, it } from "vitest";
import { calculateStartingCombatStats } from "./starting-combat-stats.js";
import type { FormationBonus } from "./formation-bonus-calculator.js";
import { createPercentage } from "./percentage.js";
import type { BaseStats } from "../catalog/unit-definition.js";
import type { MemoryModifier } from "../catalog/memory-definition.js";

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
  it("UT-R-STA-01-010: with no formation bonus, matching aptitude, and no Memory, combat stats equal base stats", () => {
    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
      memoryModifiers: [],
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
      memoryModifiers: [],
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
      memoryModifiers: [],
    });

    expect(result.maximumHp).toBeCloseTo(950);
    expect(result.attack).toBeCloseTo(190);
    expect(result.defense).toBeCloseTo(95);
    expect(result.criticalRate).toBeCloseTo(0.1);
    expect(result.actionSpeed).toBeCloseTo(50);
  });

  it("UT-R-STA-01-013: a Memory RATIO modifier stacks as a buff into the ratio correction", () => {
    const modifiers: MemoryModifier[] = [
      { targetFilter: { kind: "ALL" }, stat: "ATTACK", valueType: "RATIO", value: 0.1 },
    ];

    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
      memoryModifiers: modifiers,
    });

    expect(result.attack).toBeCloseTo(220);
  });

  it("UT-R-STA-01-014: a Memory FIXED modifier is added after every multiplier", () => {
    const modifiers: MemoryModifier[] = [
      { targetFilter: { kind: "ALL" }, stat: "MAXIMUM_HP", valueType: "FIXED", value: 300 },
    ];

    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
      memoryModifiers: modifiers,
    });

    expect(result.maximumHp).toBeCloseTo(1300);
  });

  it("UT-R-STA-01-015: multiple Memory RATIO modifiers for the same stat sum together (R-STA-02)", () => {
    const modifiers: MemoryModifier[] = [
      { targetFilter: { kind: "ALL" }, stat: "DEFENSE", valueType: "RATIO", value: 0.1 },
      { targetFilter: { kind: "ALL" }, stat: "DEFENSE", valueType: "RATIO", value: 0.2 },
    ];

    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
      memoryModifiers: modifiers,
    });

    expect(result.defense).toBeCloseTo(130);
  });

  it("UT-R-STA-01-016: a Memory modifier for one stat never leaks into another stat", () => {
    const modifiers: MemoryModifier[] = [
      { targetFilter: { kind: "ALL" }, stat: "ATTACK", valueType: "FIXED", value: 999 },
    ];

    const result = calculateStartingCombatStats({
      baseStats: BASE_STATS,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
      memoryModifiers: modifiers,
    });

    expect(result.maximumHp).toBeCloseTo(1000);
    expect(result.defense).toBeCloseTo(100);
    expect(result.criticalRate).toBeCloseTo(0.1);
  });

  it("UT-R-STA-01-017: a per-unit overridden criticalDamageBonus flows through as the base value, still receiving Memory FIXED corrections", () => {
    const overriddenBaseStats: BaseStats = { ...BASE_STATS, criticalDamageBonus: 0.8 };
    const modifiers: MemoryModifier[] = [
      {
        targetFilter: { kind: "ALL" },
        stat: "CRITICAL_DAMAGE_BONUS",
        valueType: "FIXED",
        value: 0.1,
      },
    ];

    const result = calculateStartingCombatStats({
      baseStats: overriddenBaseStats,
      positionAptitudes: ["FRONT"],
      row: "FRONT",
      formationBonus: ZERO_BONUS,
      memoryModifiers: modifiers,
    });

    expect(result.criticalDamageBonus).toBeCloseTo(0.9);
  });

  it("UT-R-ATR-02-004: affinityBonus is copied through as-is from baseStats, unaffected by formation/aptitude/Memory", () => {
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
      memoryModifiers: [],
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
      memoryModifiers: [],
    });

    expect(result.affinityBonus).toBeCloseTo(0.4);
  });
});
