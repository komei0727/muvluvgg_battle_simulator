import { describe, expect, it } from "vitest";
import { isFavorableAttribute, resolveAttributeMultiplier } from "./attribute-affinity-policy.js";
import type { Attribute } from "../catalog/catalog-enums.js";
import { createPercentage } from "./percentage.js";

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
  it("UT-R-ATR-02-001: a favorable matchup multiplies by 125% plus the attacker's affinity bonus", () => {
    const result = resolveAttributeMultiplier("AGGRESSIVE", "SHY", createPercentage(0.25));
    expect(result).toBeCloseTo(1.5);
  });

  it("UT-R-ATR-02-002: a non-favorable matchup always multiplies by exactly 100%, ignoring the affinity bonus", () => {
    const result = resolveAttributeMultiplier("AGGRESSIVE", "CUTE", createPercentage(0.25));
    expect(result).toBeCloseTo(1);
  });

  it("UT-R-ATR-02-003: zero affinity bonus on a favorable matchup still applies the base 125%", () => {
    const result = resolveAttributeMultiplier("AGGRESSIVE", "SHY", createPercentage(0));
    expect(result).toBeCloseTo(1.25);
  });
});
