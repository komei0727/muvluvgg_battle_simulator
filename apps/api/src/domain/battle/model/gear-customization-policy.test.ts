import { describe, expect, it } from "vitest";
import {
  calculateGearRatios,
  type GearGrade,
  type GearSpecification,
  type GearTier,
} from "./gear-customization-policy.js";
import { STAT_KINDS, type StatKind } from "../../catalog/definitions/catalog-enums.js";

const GRADES: readonly GearGrade[] = ["D", "C", "B", "A", "S"];

/**
 * R-ENH-04 #3の効果表（パーセントポイント）をそのまま転記したフィクスチャ。
 * 並びは `Ⅱ-D／Ⅱ-C／Ⅱ-B／Ⅱ-A／Ⅱ-S／Ⅲ-D／Ⅲ-C／Ⅲ-B／Ⅲ-A／Ⅲ-S`。
 */
const EFFECT_TABLE: Readonly<Record<StatKind, readonly number[]>> = {
  MAXIMUM_HP: [0.75, 1.18, 1.62, 2.06, 2.49, 1, 1.58, 2.16, 2.75, 3.33],
  ATTACK: [0.75, 1.18, 1.62, 2.06, 2.49, 1, 1.58, 2.16, 2.75, 3.33],
  DEFENSE: [0.75, 1.18, 1.62, 2.06, 2.49, 1, 1.58, 2.16, 2.75, 3.33],
  ACTION_SPEED: [1.5, 2.62, 3.37, 4.49, 5.4, 2, 3.5, 4.5, 6, 7.19],
  CRITICAL_RATE: [1.5, 2.62, 3.59, 4.49, 5.25, 2, 3.5, 4.8, 6, 7],
  CRITICAL_DAMAGE_BONUS: [3.75, 6.37, 8.62, 10.5, 12.37, 5, 8.5, 11.5, 14, 16.5],
  AFFINITY_BONUS: [3.75, 4.87, 5.43, 6, 6.37, 5, 6.5, 7.25, 8, 8.5],
};

function gear(stat: StatKind, tier: GearTier, grade: GearGrade): GearSpecification {
  return { stat, tier, grade };
}

describe("calculateGearRatios — R-ENH-04 ギアカスタム", () => {
  it("UT-R-ENH-04-001: no gears leaves every stat at zero", () => {
    const ratios = calculateGearRatios([]);
    for (const stat of STAT_KINDS) {
      expect(ratios[stat]).toBe(0);
    }
    expect(calculateGearRatios(undefined)).toEqual(ratios);
  });

  it("UT-R-ENH-04-002: every cell of the effect table converts its percentage点 into the internal decimal", () => {
    for (const stat of STAT_KINDS) {
      const row = EFFECT_TABLE[stat];
      for (const [index, tier] of (["II", "III"] as const).entries()) {
        for (const [gradeIndex, grade] of GRADES.entries()) {
          const expected = row[index * GRADES.length + gradeIndex]!;
          const ratios = calculateGearRatios([gear(stat, tier, grade)]);
          expect(ratios[stat], `${stat} ${tier}-${grade}`).toBeCloseTo(expected / 100, 12);
          for (const other of STAT_KINDS.filter((candidate) => candidate !== stat)) {
            expect(ratios[other], `${stat} ${tier}-${grade} leaked into ${other}`).toBe(0);
          }
        }
      }
    }
  });

  it("UT-R-ENH-04-003: gears targeting the same stat are summed", () => {
    const ratios = calculateGearRatios([
      gear("MAXIMUM_HP", "III", "S"),
      gear("MAXIMUM_HP", "III", "S"),
      gear("MAXIMUM_HP", "II", "D"),
    ]);
    expect(ratios.MAXIMUM_HP).toBeCloseTo((3.33 + 3.33 + 0.75) / 100, 12);
  });

  it("UT-R-ENH-04-004: gears targeting different stats accumulate independently", () => {
    const ratios = calculateGearRatios([
      gear("ATTACK", "II", "A"),
      gear("CRITICAL_RATE", "II", "S"),
      gear("AFFINITY_BONUS", "III", "S"),
    ]);
    expect(ratios.ATTACK).toBeCloseTo(2.06 / 100, 12);
    expect(ratios.CRITICAL_RATE).toBeCloseTo(0.0525, 12);
    expect(ratios.AFFINITY_BONUS).toBeCloseTo(8.5 / 100, 12);
    expect(ratios.DEFENSE).toBe(0);
    expect(ratios.MAXIMUM_HP).toBe(0);
  });

  it("UT-R-ENH-04-005: a full nine-gear loadout on one stat sums all nine", () => {
    const ratios = calculateGearRatios(
      Array.from({ length: 9 }, () => gear("ACTION_SPEED", "III", "A")),
    );
    expect(ratios.ACTION_SPEED).toBeCloseTo((6 * 9) / 100, 12);
  });
});
