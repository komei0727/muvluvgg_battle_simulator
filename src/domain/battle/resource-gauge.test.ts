import { describe, expect, it } from "vitest";
import {
  createActionPoint,
  createExtraGauge,
  createHitPoint,
  createPassivePoint,
  truncateFraction,
} from "./resource-gauge.js";
import { DomainValidationError } from "../shared/errors.js";

describe("truncateFraction (R-NUM-02)", () => {
  it("UT-R-NUM-02-001: drops the fractional part of a positive value", () => {
    expect(truncateFraction(3.9)).toBe(3);
  });

  it("UT-R-NUM-02-002: truncates toward zero for a negative value", () => {
    expect(truncateFraction(-3.9)).toBe(-3);
  });

  it("UT-R-NUM-02-003: leaves an already-integer value unchanged", () => {
    expect(truncateFraction(7)).toBe(7);
  });

  it("UT-R-NUM-02-004: truncates a value just below an integer boundary", () => {
    expect(truncateFraction(4.9999)).toBe(4);
  });
});

describe("HitPoint (R-NUM-02)", () => {
  it("UT-R-NUM-02-005: accepts the lower bound 0", () => {
    expect(createHitPoint(0, 100)).toBe(0);
  });

  it("UT-R-NUM-02-006: accepts the upper bound equal to max", () => {
    expect(createHitPoint(100, 100)).toBe(100);
  });

  it("UT-R-NUM-02-007: truncates a fractional value before validating bounds", () => {
    expect(createHitPoint(99.9, 100)).toBe(99);
  });

  it("UT-R-NUM-02-008: rejects a negative value", () => {
    expect(() => createHitPoint(-1, 100)).toThrow(DomainValidationError);
  });

  it("UT-R-NUM-02-009: rejects a value exceeding max", () => {
    expect(() => createHitPoint(101, 100)).toThrow(DomainValidationError);
  });

  it("UT-R-NUM-02-010: rejects a value that truncates to exceed max", () => {
    expect(() => createHitPoint(101.1, 100)).toThrow(DomainValidationError);
  });
});

describe("ActionPoint / PassivePoint / ExtraGauge share the HitPoint contract (R-NUM-02)", () => {
  it("UT-R-NUM-02-011: ActionPoint never goes negative", () => {
    expect(() => createActionPoint(-1, 4)).toThrow(DomainValidationError);
    expect(createActionPoint(0, 4)).toBe(0);
  });

  it("UT-R-NUM-02-012: PassivePoint never goes negative", () => {
    expect(() => createPassivePoint(-1, 4)).toThrow(DomainValidationError);
    expect(createPassivePoint(0, 4)).toBe(0);
  });

  it("UT-R-NUM-02-013: ExtraGauge does not retain the excess above max", () => {
    expect(() => createExtraGauge(8, 7)).toThrow(DomainValidationError);
    expect(createExtraGauge(7, 7)).toBe(7);
  });
});
