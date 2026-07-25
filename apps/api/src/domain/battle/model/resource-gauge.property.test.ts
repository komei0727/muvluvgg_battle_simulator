import { describe, it } from "vitest";
import { increaseExtraGaugeWithOverflow, truncateFraction } from "./resource-gauge.js";
import { fc, PROPERTY_ASSERT_CONFIG } from "../../../testing/property/index.js";

/**
 * R-NUM-02（最終切り捨て）と R-ACT-03（EXゲージの上限打ち止め・超過分の非保持）の
 * 不変条件を property-based test で検証する（`12_テスト戦略.md`「Property／Modelテスト」:
 * EXゲージが最大値を超えない／リソースが負数にならない）。
 */
describe("truncateFraction properties (R-NUM-02)", () => {
  it("PROP-NUM-02-001: truncates toward zero and is idempotent", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (value) => {
        const truncated = truncateFraction(value);
        return (
          Number.isInteger(truncated) &&
          Math.abs(truncated) <= Math.abs(value) &&
          truncateFraction(truncated) === truncated
        );
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});

describe("increaseExtraGaugeWithOverflow properties (R-ACT-03)", () => {
  const gaugeInputArb = fc
    .record({
      max: fc.integer({ min: 0, max: 500 }),
      currentRatio: fc.double({ min: 0, max: 1, noNaN: true }),
      amount: fc.integer({ min: 0, max: 500 }),
    })
    .map(({ max, currentRatio, amount }) => ({
      max,
      current: Math.trunc(currentRatio * max),
      amount,
    }));

  it("PROP-ACT-03-001: gauge never exceeds the maximum and stays non-negative", () => {
    fc.assert(
      fc.property(gaugeInputArb, ({ current, amount, max }) => {
        const result = increaseExtraGaugeWithOverflow(current, amount, max);
        return result.gauge >= 0 && result.gauge <= max;
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ACT-03-002: conserves the requested amount (increased + discarded === amount)", () => {
    fc.assert(
      fc.property(gaugeInputArb, ({ current, amount, max }) => {
        const result = increaseExtraGaugeWithOverflow(current, amount, max);
        return (
          result.increasedAmount + result.discardedAmount === amount &&
          result.increasedAmount >= 0 &&
          result.discardedAmount >= 0
        );
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ACT-03-003: discards nothing while the result stays within capacity", () => {
    fc.assert(
      fc.property(gaugeInputArb, ({ current, amount, max }) => {
        const result = increaseExtraGaugeWithOverflow(current, amount, max);
        if (current + amount <= max) {
          return result.discardedAmount === 0 && result.gauge === current + amount;
        }
        return result.gauge === max;
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
