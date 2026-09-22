import { describe, expect, it } from "vitest";
import { isFavorableAttribute, resolveAttributeMultiplier } from "./attribute-affinity-policy.js";
import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import { createPercentage } from "../../shared/percentage.js";

const ALL_ATTRIBUTES: readonly Attribute[] = [
  "AGGRESSIVE",
  "SHY",
  "CUTE",
  "SMART",
  "COMICAL",
  "CLEVER",
];

describe("isFavorableAttribute — R-ATR-01 有利属性", () => {
  it("UT-R-ATR-01-001: AGGRESSIVE attacking SHY is favorable", () => {
    expect(isFavorableAttribute("AGGRESSIVE", "SHY")).toBe(true);
  });

  it("UT-R-ATR-01-002: SHY attacking CUTE is favorable", () => {
    expect(isFavorableAttribute("SHY", "CUTE")).toBe(true);
  });

  it("UT-R-ATR-01-003: CUTE attacking SMART is favorable", () => {
    expect(isFavorableAttribute("CUTE", "SMART")).toBe(true);
  });

  it("UT-R-ATR-01-004: SMART attacking AGGRESSIVE is favorable", () => {
    expect(isFavorableAttribute("SMART", "AGGRESSIVE")).toBe(true);
  });

  it("UT-R-ATR-01-005: COMICAL attacking CLEVER is favorable", () => {
    expect(isFavorableAttribute("COMICAL", "CLEVER")).toBe(true);
  });

  it("UT-R-ATR-01-006: CLEVER attacking COMICAL is favorable", () => {
    expect(isFavorableAttribute("CLEVER", "COMICAL")).toBe(true);
  });

  it("UT-R-ATR-01-007: favorability is one-directional (the reverse pair is not favorable)", () => {
    expect(isFavorableAttribute("SHY", "AGGRESSIVE")).toBe(false);
  });

  it("UT-R-ATR-01-008: every attribute against itself is not favorable", () => {
    for (const attribute of ALL_ATTRIBUTES) {
      expect(isFavorableAttribute(attribute, attribute)).toBe(false);
    }
  });

  it("UT-R-ATR-01-009: exhaustive table — only the 6 documented pairs are favorable", () => {
    const favorablePairs = new Set<string>();
    for (const attacker of ALL_ATTRIBUTES) {
      for (const defender of ALL_ATTRIBUTES) {
        if (isFavorableAttribute(attacker, defender)) {
          favorablePairs.add(`${attacker}->${defender}`);
        }
      }
    }
    expect(favorablePairs).toEqual(
      new Set([
        "AGGRESSIVE->SHY",
        "SHY->CUTE",
        "CUTE->SMART",
        "SMART->AGGRESSIVE",
        "COMICAL->CLEVER",
        "CLEVER->COMICAL",
      ]),
    );
  });
});

describe("resolveAttributeMultiplier — R-ATR-02 属性倍率", () => {
  // `affinityBonus`は既定値25%（Q-CAT-05）を含んだユニットステータスであり、
  // R-ATR-02の「125%」はその既定値込みの結果である。倍率式が125%を別途足すと
  // 既定値が二重に乗るため、既定値そのものを入力にした倍率をここで固定する。
  it("UT-R-ATR-02-001: the default 25% affinity bonus yields exactly the 125% favorable multiplier", () => {
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "SHY",
      createPercentage(0.25),
      undefined,
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1.25);
  });

  it("UT-R-ATR-02-002: a non-favorable matchup always multiplies by exactly 100%, ignoring the affinity bonus", () => {
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "CUTE",
      createPercentage(0.25),
      undefined,
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1);
  });

  it("UT-R-ATR-02-003: a raised affinity bonus adds the same percentage points to the favorable multiplier", () => {
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "SHY",
      createPercentage(0.35),
      undefined,
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1.35);
  });

  it("UT-R-ATR-02-006: a zero affinity bonus leaves a favorable matchup at 100%", () => {
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "SHY",
      createPercentage(0),
      undefined,
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1);
  });
});

describe("resolveAttributeMultiplier — R-ATR-03 サブ属性の属性倍率", () => {
  it("UT-R-ATR-03-001: main not favorable, sub favorable — applies the sub affinity bonus (15%)", () => {
    // AGGRESSIVE main is not favorable against CUTE; SHY sub is favorable against CUTE
    // (SHY -> CUTE, R-ATR-01) — falls through to the sub bonus, not the main one.
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "CUTE",
      createPercentage(0.25),
      "SHY",
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1.15);
  });

  it("UT-R-ATR-03-002: main favorable — ignores the sub attribute and applies the main bonus (25%)", () => {
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "SHY",
      createPercentage(0.25),
      "CLEVER",
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1.25);
  });

  it("UT-R-ATR-03-003: neither main nor sub favorable — multiplies by exactly 100%", () => {
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "CUTE",
      createPercentage(0.25),
      "SMART",
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1);
  });

  it("UT-R-ATR-03-004: no sub attribute — behaves exactly like a unit without one", () => {
    const result = resolveAttributeMultiplier(
      "AGGRESSIVE",
      "CUTE",
      createPercentage(0.25),
      undefined,
      createPercentage(0.15),
    );
    expect(result).toBeCloseTo(1);
  });
});
