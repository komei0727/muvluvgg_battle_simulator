import { describe, expect, it } from "vitest";
import { createPercentage, resolveProbability } from "./percentage.js";
import { DomainValidationError } from "./errors.js";
import { SequenceRandomSource } from "../../testing/random/sequence-random-source.js";

describe("Percentage (R-NUM-01)", () => {
  it("UT-R-NUM-01-001: represents 100% as the internal value 1.0", () => {
    expect(createPercentage(1.0)).toBe(1.0);
  });

  it("UT-R-NUM-01-002: preserves an unrounded intermediate value (25% addition)", () => {
    const base = createPercentage(1.0);
    const added = createPercentage(base + 0.25);
    expect(added).toBe(1.25);
  });

  it("UT-R-NUM-01-003: preserves an unrounded intermediate value (5% subtraction)", () => {
    const base = createPercentage(1.0);
    const subtracted = createPercentage(base - 0.05);
    expect(subtracted).toBeCloseTo(0.95, 10);
  });

  it("UT-R-NUM-01-004 / UT-R-NUM-03-004: places no upper or lower bound on the raw stat value", () => {
    expect(createPercentage(-0.5)).toBe(-0.5);
    expect(createPercentage(3.0)).toBe(3.0);
  });

  it("UT-R-NUM-01-005: rejects a non-finite value", () => {
    expect(() => createPercentage(Number.NaN)).toThrow(DomainValidationError);
  });
});

describe("resolveProbability (R-NUM-03)", () => {
  it("UT-R-NUM-03-001: 0% always fails, even for the lowest possible roll", () => {
    const random = new SequenceRandomSource([0]);
    expect(resolveProbability(createPercentage(0), random)).toBe(false);
  });

  it("UT-R-NUM-03-002: 100% always succeeds, even for the highest possible roll", () => {
    const random = new SequenceRandomSource([0.999999]);
    expect(resolveProbability(createPercentage(1.0), random)).toBe(true);
  });

  it("UT-R-NUM-03-003: succeeds when the roll is just below the threshold", () => {
    const random = new SequenceRandomSource([0.29]);
    expect(resolveProbability(createPercentage(0.3), random)).toBe(true);
  });

  it("UT-R-NUM-03-004: fails when the roll equals the threshold", () => {
    const random = new SequenceRandomSource([0.3]);
    expect(resolveProbability(createPercentage(0.3), random)).toBe(false);
  });

  it("UT-R-NUM-03-005: fails when the roll is just above the threshold", () => {
    const random = new SequenceRandomSource([0.31]);
    expect(resolveProbability(createPercentage(0.3), random)).toBe(false);
  });

  it("UT-R-NUM-03-006: clamps an out-of-range stat value to 0..100% only for the judgment", () => {
    const random = new SequenceRandomSource([0.999999]);
    expect(resolveProbability(createPercentage(3.0), random)).toBe(true);

    const randomBelowZero = new SequenceRandomSource([0]);
    expect(resolveProbability(createPercentage(-0.5), randomBelowZero)).toBe(false);
  });
});
