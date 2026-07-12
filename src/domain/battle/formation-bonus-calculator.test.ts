import { describe, expect, it } from "vitest";
import { calculateFormationBonus } from "./formation-bonus-calculator.js";
import type { Attribute } from "../catalog/catalog-enums.js";

function attrs(...values: Attribute[]): readonly Attribute[] {
  return values;
}

describe("calculateFormationBonus — R-BON-01 通常属性の役判定", () => {
  it("UT-R-BON-01-001: five of the same attribute grants five-card (+25% attack, +25% HP)", () => {
    const bonus = calculateFormationBonus(
      attrs("AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE"),
    );
    expect(bonus.attackBonus).toBeCloseTo(0.25);
    expect(bonus.hpBonus).toBeCloseTo(0.25);
  });

  it("UT-R-BON-01-002: four of the same attribute plus one other grants four-card (+15% attack, +20% HP)", () => {
    const bonus = calculateFormationBonus(attrs("SHY", "SHY", "SHY", "SHY", "CUTE"));
    expect(bonus.attackBonus).toBeCloseTo(0.15);
    expect(bonus.hpBonus).toBeCloseTo(0.2);
  });

  it("UT-R-BON-01-003: three of one attribute plus two of another grants full house (+15% attack, +15% HP)", () => {
    const bonus = calculateFormationBonus(attrs("SMART", "SMART", "SMART", "CUTE", "CUTE"));
    expect(bonus.attackBonus).toBeCloseTo(0.15);
    expect(bonus.hpBonus).toBeCloseTo(0.15);
  });

  it("UT-R-BON-01-004: three of one attribute plus two distinct singles grants three-card (+10% attack, +10% HP)", () => {
    const bonus = calculateFormationBonus(
      attrs("AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE", "SHY", "CUTE"),
    );
    expect(bonus.attackBonus).toBeCloseTo(0.1);
    expect(bonus.hpBonus).toBeCloseTo(0.1);
  });

  it("UT-R-BON-01-005: no matching hand grants zero bonus", () => {
    const bonus = calculateFormationBonus(
      attrs("AGGRESSIVE", "SHY", "CUTE", "SMART", "AGGRESSIVE"),
    );
    expect(bonus.attackBonus).toBeCloseTo(0);
    expect(bonus.hpBonus).toBeCloseTo(0);
  });

  it("UT-R-BON-01-006: a formation of 4 or fewer never gets a role, even with matching attributes", () => {
    const bonus = calculateFormationBonus(
      attrs("AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE"),
    );
    expect(bonus.attackBonus).toBeCloseTo(0);
    expect(bonus.hpBonus).toBeCloseTo(0);
  });

  it("UT-R-BON-01-007: Clever members are excluded from the hand, shrinking the pool that must match", () => {
    const bonus = calculateFormationBonus(attrs("CLEVER", "SHY", "SHY", "SHY", "SHY"));
    expect(bonus.attackBonus).toBeCloseTo(0.15);
    expect(bonus.hpBonus).toBeCloseTo(0.2);
  });
});

describe("calculateFormationBonus — R-BON-03 クレバー", () => {
  it("UT-R-BON-03-001: 1 Clever grants +30% defense only", () => {
    const bonus = calculateFormationBonus(attrs("CLEVER", "SHY", "CUTE", "SMART", "AGGRESSIVE"));
    expect(bonus.defenseBonus).toBeCloseTo(0.3);
    expect(bonus.attackBonus).toBeCloseTo(0);
    expect(bonus.hpBonus).toBeCloseTo(0);
    expect(bonus.criticalRateBonus).toBeCloseTo(0);
  });

  it("UT-R-BON-03-002: 2 Clever accumulates +30% defense and +10% attack/HP", () => {
    const bonus = calculateFormationBonus(attrs("CLEVER", "CLEVER", "CUTE", "SMART", "AGGRESSIVE"));
    expect(bonus.defenseBonus).toBeCloseTo(0.3);
    expect(bonus.attackBonus).toBeCloseTo(0.1);
    expect(bonus.hpBonus).toBeCloseTo(0.1);
    expect(bonus.criticalRateBonus).toBeCloseTo(0);
  });

  it("UT-R-BON-03-003: 3 Clever accumulates defense, attack/HP, and +15% critical rate", () => {
    const bonus = calculateFormationBonus(
      attrs("CLEVER", "CLEVER", "CLEVER", "SMART", "AGGRESSIVE"),
    );
    expect(bonus.defenseBonus).toBeCloseTo(0.3);
    expect(bonus.attackBonus).toBeCloseTo(0.1);
    expect(bonus.hpBonus).toBeCloseTo(0.1);
    expect(bonus.criticalRateBonus).toBeCloseTo(0.15);
  });

  it("UT-R-BON-03-004: 4 Clever adds the higher attack/HP stage on top (cumulative, not replacing)", () => {
    const bonus = calculateFormationBonus(
      attrs("CLEVER", "CLEVER", "CLEVER", "CLEVER", "AGGRESSIVE"),
    );
    expect(bonus.defenseBonus).toBeCloseTo(0.3);
    expect(bonus.attackBonus).toBeCloseTo(0.1 + 0.15);
    expect(bonus.hpBonus).toBeCloseTo(0.1 + 0.15);
    expect(bonus.criticalRateBonus).toBeCloseTo(0.15);
  });

  it("UT-R-BON-03-005: 5 Clever accumulates every stage", () => {
    const bonus = calculateFormationBonus(attrs("CLEVER", "CLEVER", "CLEVER", "CLEVER", "CLEVER"));
    expect(bonus.defenseBonus).toBeCloseTo(0.3);
    expect(bonus.attackBonus).toBeCloseTo(0.1 + 0.15 + 0.25);
    expect(bonus.hpBonus).toBeCloseTo(0.1 + 0.15 + 0.25);
    expect(bonus.criticalRateBonus).toBeCloseTo(0.15);
  });

  it("UT-R-BON-03-006: 0 Clever grants no Clever bonus at all", () => {
    const bonus = calculateFormationBonus(attrs("SHY", "CUTE", "SMART", "AGGRESSIVE", "SHY"));
    expect(bonus.defenseBonus).toBeCloseTo(0);
    expect(bonus.criticalRateBonus).toBeCloseTo(0);
  });
});

describe("calculateFormationBonus — R-BON-02 コミカル", () => {
  it("UT-R-BON-02-001: a single Comical is assigned to complete a five-card", () => {
    const bonus = calculateFormationBonus(
      attrs("AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE", "AGGRESSIVE", "COMICAL"),
    );
    expect(bonus.attackBonus).toBeCloseTo(0.25);
    expect(bonus.hpBonus).toBeCloseTo(0.25);
  });

  it("UT-R-BON-02-002: two Comical members both join the existing trio to complete a five-card", () => {
    const bonus = calculateFormationBonus(attrs("SHY", "SHY", "SHY", "COMICAL", "COMICAL"));
    expect(bonus.attackBonus).toBeCloseTo(0.25);
    expect(bonus.hpBonus).toBeCloseTo(0.25);
  });

  it("UT-R-BON-02-003: a single Comical joins one of two even pairs to complete a full house when no better candidate exists", () => {
    const bonus = calculateFormationBonus(attrs("SHY", "SHY", "CUTE", "CUTE", "COMICAL"));
    expect(bonus.attackBonus).toBeCloseTo(0.15);
    expect(bonus.hpBonus).toBeCloseTo(0.15);
  });

  it("UT-R-BON-02-004: Comical members are never treated as Clever", () => {
    const bonus = calculateFormationBonus(
      attrs("COMICAL", "COMICAL", "COMICAL", "COMICAL", "COMICAL"),
    );
    expect(bonus.attackBonus).toBeCloseTo(0.25);
    expect(bonus.hpBonus).toBeCloseTo(0.25);
    expect(bonus.defenseBonus).toBeCloseTo(0);
    expect(bonus.criticalRateBonus).toBeCloseTo(0);
  });

  it("UT-R-BON-02-005: result does not depend on the order Comical members appear in the input", () => {
    const forward = calculateFormationBonus(attrs("COMICAL", "SHY", "SHY", "SHY", "CUTE"));
    const reversed = calculateFormationBonus(attrs("CUTE", "SHY", "SHY", "SHY", "COMICAL"));
    expect(reversed).toEqual(forward);
  });
});

describe("calculateFormationBonus — 入力順を入れ替えた決定性", () => {
  it("UT-R-BON-01-008: every permutation of a mixed formation (normal/Comical/Clever) yields the same bonus", () => {
    const base = attrs("CLEVER", "COMICAL", "SHY", "SHY", "CUTE");
    const baseline = calculateFormationBonus(base);

    // A fixed sample of permutations (full 120-permutation enumeration is
    // unnecessary — a rotation and a full reversal already exercise every
    // element moving relative to every other).
    const rotated = [...base.slice(1), base[0]!];
    const reversed = [...base].reverse();

    expect(calculateFormationBonus(rotated)).toEqual(baseline);
    expect(calculateFormationBonus(reversed)).toEqual(baseline);
  });
});
