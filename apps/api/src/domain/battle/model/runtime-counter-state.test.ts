import { describe, expect, it } from "vitest";
import {
  applyCumulativeDamageThreshold,
  incrementRuntimeCounter,
  resetRuntimeCounter,
  type RuntimeCounterMap,
} from "./runtime-counter-state.js";
import { createRuntimeCounterId } from "../../catalog/definitions/catalog-ids.js";

const COUNTER_A = createRuntimeCounterId("RUNTIME_COUNTER_A");
const COUNTER_B = createRuntimeCounterId("RUNTIME_COUNTER_B");

describe("runtime-counter-state", () => {
  describe("incrementRuntimeCounter (R-EFF-11 / RUNTIME_COUNTER_MODULO)", () => {
    it("UT-RCOUNTER-001: increments an absent counter from an implicit 0", () => {
      const result = incrementRuntimeCounter({}, COUNTER_A, 1);
      expect(result.change).toEqual({ counter: COUNTER_A, before: 0, after: 1 });
      expect(result.counters[COUNTER_A]).toEqual({ value: 1, carry: 0 });
    });

    it("UT-RCOUNTER-002: increments an existing counter by the given amount", () => {
      const counters: RuntimeCounterMap = { [COUNTER_A]: { value: 3, carry: 0 } };
      const result = incrementRuntimeCounter(counters, COUNTER_A, 1);
      expect(result.change).toEqual({ counter: COUNTER_A, before: 3, after: 4 });
    });

    it("UT-RCOUNTER-003: leaves other counters untouched", () => {
      const counters: RuntimeCounterMap = {
        [COUNTER_A]: { value: 3, carry: 0 },
        [COUNTER_B]: { value: 9, carry: 0 },
      };
      const result = incrementRuntimeCounter(counters, COUNTER_A, 1);
      expect(result.counters[COUNTER_B]).toEqual({ value: 9, carry: 0 });
    });
  });

  describe("applyCumulativeDamageThreshold (R-EFF-11 / CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER)", () => {
    it("UT-RCOUNTER-004: does not cross a threshold when damage stays below it", () => {
      const result = applyCumulativeDamageThreshold({}, COUNTER_A, 30, 100, 0.4);
      expect(result.change).toEqual({ counter: COUNTER_A, before: 0, after: 0 });
      expect(result.counters[COUNTER_A]).toEqual({ value: 0, carry: 30 });
    });

    it("UT-RCOUNTER-005: crosses exactly one threshold and carries no remainder", () => {
      const result = applyCumulativeDamageThreshold({}, COUNTER_A, 40, 100, 0.4);
      expect(result.change).toEqual({ counter: COUNTER_A, before: 0, after: 1 });
      expect(result.counters[COUNTER_A]).toEqual({ value: 1, carry: 0 });
    });

    it("UT-RCOUNTER-006: a single update crossing multiple thresholds increments by the crossing count and carries the remainder", () => {
      const result = applyCumulativeDamageThreshold({}, COUNTER_A, 105, 100, 0.4);
      // threshold = 40; 105 / 40 = 2 crossings (80), remainder 25
      expect(result.change).toEqual({ counter: COUNTER_A, before: 0, after: 2 });
      expect(result.counters[COUNTER_A]).toEqual({ value: 2, carry: 25 });
    });

    it("UT-RCOUNTER-007: carries the remainder across updates and crosses on a later update", () => {
      const first = applyCumulativeDamageThreshold({}, COUNTER_A, 30, 100, 0.4);
      expect(first.counters[COUNTER_A]).toEqual({ value: 0, carry: 30 });
      const second = applyCumulativeDamageThreshold(first.counters, COUNTER_A, 15, 100, 0.4);
      // carry 30 + 15 = 45 >= 40: one crossing, remainder 5
      expect(second.change).toEqual({ counter: COUNTER_A, before: 0, after: 1 });
      expect(second.counters[COUNTER_A]).toEqual({ value: 1, carry: 5 });
    });

    it("UT-RCOUNTER-008: an exact multiple crossing carries a zero remainder", () => {
      const result = applyCumulativeDamageThreshold({}, COUNTER_A, 80, 100, 0.4);
      expect(result.change).toEqual({ counter: COUNTER_A, before: 0, after: 2 });
      expect(result.counters[COUNTER_A]).toEqual({ value: 2, carry: 0 });
    });
  });

  describe("resetRuntimeCounter (R-EFF-11 scope-end reset)", () => {
    it("UT-RCOUNTER-009: discards an existing counter, reporting its prior value", () => {
      const counters: RuntimeCounterMap = { [COUNTER_A]: { value: 5, carry: 3 } };
      const result = resetRuntimeCounter(counters, COUNTER_A);
      expect(result).toEqual({
        counters: {},
        change: { counter: COUNTER_A, before: 5, after: 0 },
      });
    });

    it("UT-RCOUNTER-010: is a no-op for a counter that was never set", () => {
      const result = resetRuntimeCounter({}, COUNTER_A);
      expect(result).toBeUndefined();
    });

    it("UT-RCOUNTER-011: leaves other counters untouched", () => {
      const counters: RuntimeCounterMap = {
        [COUNTER_A]: { value: 5, carry: 0 },
        [COUNTER_B]: { value: 2, carry: 0 },
      };
      const result = resetRuntimeCounter(counters, COUNTER_A);
      expect(result?.counters[COUNTER_B]).toEqual({ value: 2, carry: 0 });
    });
  });
});
