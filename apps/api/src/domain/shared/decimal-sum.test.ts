import { describe, expect, it } from "vitest";
import { addDecimalValues } from "./decimal-sum.js";

describe("addDecimalValues (R-NUM-02)", () => {
  it("UT-R-NUM-02-014: sums two short decimals to the value of their exact decimal sum", () => {
    // binary64 の 0.848 + 0.075 は 0.92299…
    expect(addDecimalValues(0.848, 0.075)).toBe(0.923);
    expect(addDecimalValues(addDecimalValues(0.075, 0.075), 0.075)).toBe(0.225);
    expect(addDecimalValues(1.5, -0.25)).toBe(1.25);
  });

  it("UT-R-NUM-02-015 (boundary): keeps the binary64 sum when an operand is not a short decimal", () => {
    // 生存割合 1/3 のような評価値は10進の有限小数ではないため、有効桁を落とさない。
    expect(addDecimalValues(0.4, 1 / 3)).toBe(0.4 + 1 / 3);
    expect(addDecimalValues(1e-11, 0.5)).toBe(1e-11 + 0.5);
  });

  it("UT-R-NUM-02-016: returns the other operand unchanged when one operand is 0", () => {
    expect(addDecimalValues(0.7333333333333334, 0)).toBe(0.7333333333333334);
    expect(addDecimalValues(0, 0.848)).toBe(0.848);
  });
});
