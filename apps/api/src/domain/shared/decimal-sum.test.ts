import { describe, expect, it } from "vitest";
import { sumDecimalValues, sumDecimalValuesAtLeastZero } from "./decimal-sum.js";

describe("sumDecimalValuesAtLeastZero (R-NUM-02)", () => {
  it("UT-R-NUM-02-014: sums the shortest round-trip decimals exactly and converts once", () => {
    // binary64 の 0.848 + 0.075 は 0.92299…
    expect(sumDecimalValuesAtLeastZero([0.848, 0.075])).toBe(0.923);
    // binary64 の逐次和は 0.22499999999999998。
    expect(sumDecimalValuesAtLeastZero([0.075, 0.075, 0.075])).toBe(0.225);
  });

  it("UT-R-NUM-02-015: treats an evaluated value by its shortest decimal, independently of the order", () => {
    // 1/3 は "0.3333333333333333" として足す。
    expect(sumDecimalValuesAtLeastZero([0.4, 1 / 3])).toBe(0.7333333333333333);
    const orders = [
      [0.312, 0.075, 0.075, 1 / 3],
      [0.312, 1 / 3, 0.075, 0.075],
      [0.312, 0.075, 1 / 3, 0.075],
    ];
    for (const order of orders) {
      expect(sumDecimalValuesAtLeastZero(order)).toBe(0.7953333333333333);
    }
  });

  it("UT-R-NUM-02-016 (boundary): reads exponent notation and clamps a negative total at 0", () => {
    expect(sumDecimalValuesAtLeastZero([0.5, 1e-7])).toBe(0.5000001);
    expect(sumDecimalValuesAtLeastZero([1.5e21, 0.5])).toBe(1.5e21);
    expect(sumDecimalValuesAtLeastZero([1, -1.5])).toBe(0);
    expect(sumDecimalValuesAtLeastZero([0.1, -0.1])).toBe(0);
    // 下限を設けない合計は負の値を保つ。
    expect(sumDecimalValues([-0.075, -0.075, -0.075])).toBe(-0.225);
    expect(sumDecimalValues([])).toBe(0);
  });
});
