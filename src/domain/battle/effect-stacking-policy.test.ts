import { describe, expect, it } from "vitest";
import { combineEffects, type StatEffect } from "./effect-stacking-policy.js";

function stackable(value: number): StatEffect {
  return { stacking: "STACKABLE", value };
}

function nonStackable(kindKey: string, value: number): StatEffect {
  return { stacking: "NON_STACKABLE", kindKey, value };
}

describe("combineEffects — R-STA-02 重複あり効果", () => {
  it("UT-R-STA-02-001: sums every stackable effect with its own sign", () => {
    expect(combineEffects([stackable(0.1), stackable(0.2), stackable(-0.05)])).toBeCloseTo(0.25);
  });

  it("UT-R-STA-02-002: an empty effect list contributes zero", () => {
    expect(combineEffects([])).toBeCloseTo(0);
  });
});

describe("combineEffects — R-STA-03 重複なし効果", () => {
  it("UT-R-STA-03-001: only the strongest effect in a non-stackable group is adopted", () => {
    const result = combineEffects([nonStackable("SLOW", -0.1), nonStackable("SLOW", -0.3)]);
    expect(result).toBeCloseTo(-0.3);
  });

  it("UT-R-STA-03-002: a buff's magnitude is compared by its positive value", () => {
    const result = combineEffects([nonStackable("HASTE", 0.1), nonStackable("HASTE", 0.3)]);
    expect(result).toBeCloseTo(0.3);
  });

  it("UT-R-STA-03-003: distinct EffectKindKey groups are resolved independently and summed", () => {
    const result = combineEffects([
      nonStackable("HASTE", 0.1),
      nonStackable("HASTE", 0.3),
      nonStackable("SLOW", -0.2),
      nonStackable("SLOW", -0.05),
    ]);
    expect(result).toBeCloseTo(0.3 - 0.2);
  });

  it("UT-R-STA-03-004: when candidate magnitudes tie, the result is order-independent", () => {
    const forward = combineEffects([nonStackable("HASTE", 0.2), nonStackable("HASTE", 0.2)]);
    const reversed = combineEffects([nonStackable("HASTE", 0.2), nonStackable("HASTE", 0.2)]);
    expect(forward).toBeCloseTo(0.2);
    expect(reversed).toBeCloseTo(0.2);
  });

  it("UT-R-STA-03-005: stackable and non-stackable effects combine together", () => {
    const result = combineEffects([
      stackable(0.05),
      nonStackable("HASTE", 0.1),
      nonStackable("HASTE", 0.3),
    ]);
    expect(result).toBeCloseTo(0.05 + 0.3);
  });
});
