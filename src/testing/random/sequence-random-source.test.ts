import { describe, expect, it } from "vitest";
import { SequenceRandomSource } from "./sequence-random-source.js";

describe("SequenceRandomSource", () => {
  it("UT-RAND-001: returns preset values in order", () => {
    const src = new SequenceRandomSource([0.1, 0.5, 0.9]);
    expect(src.next()).toBe(0.1);
    expect(src.next()).toBe(0.5);
    expect(src.next()).toBe(0.9);
  });

  it("UT-RAND-002: throws on underflow (values exhausted)", () => {
    const src = new SequenceRandomSource([0.3]);
    src.next();
    expect(() => src.next()).toThrow("exhausted");
  });

  it("UT-RAND-003: assertFullyConsumed passes when all values consumed", () => {
    const src = new SequenceRandomSource([0.1, 0.2]);
    src.next();
    src.next();
    expect(() => src.assertFullyConsumed()).not.toThrow();
  });

  it("UT-RAND-004: assertFullyConsumed throws when values remain (overflow)", () => {
    const src = new SequenceRandomSource([0.1, 0.9]);
    src.next();
    expect(() => src.assertFullyConsumed()).toThrow("unconsumed");
  });

  it("UT-RAND-005: tracks call count and consumed values", () => {
    const src = new SequenceRandomSource([0.2, 0.4, 0.6]);
    src.next();
    src.next();
    expect(src.callCount).toBe(2);
    expect(src.consumedValues).toEqual([0.2, 0.4]);
  });

  it("UT-RAND-006: assertFullyConsumed passes on empty sequence", () => {
    const src = new SequenceRandomSource([]);
    expect(() => src.assertFullyConsumed()).not.toThrow();
  });

  it("UT-RAND-007: underflow error does not advance call count", () => {
    const src = new SequenceRandomSource([0.5]);
    src.next();
    expect(() => src.next()).toThrow();
    expect(src.callCount).toBe(1);
  });

  describe("value range validation [0, 1)", () => {
    it("UT-RAND-008: accepts boundary value 0", () => {
      expect(() => new SequenceRandomSource([0])).not.toThrow();
    });

    it("UT-RAND-009: accepts value just below upper bound (0.9999…)", () => {
      expect(() => new SequenceRandomSource([0.9999999999])).not.toThrow();
    });

    it("UT-RAND-010: rejects negative value", () => {
      expect(() => new SequenceRandomSource([-0.1])).toThrow("out of range");
    });

    it("UT-RAND-011: rejects upper bound value 1", () => {
      expect(() => new SequenceRandomSource([1])).toThrow("out of range");
    });

    it("UT-RAND-012: rejects value greater than 1", () => {
      expect(() => new SequenceRandomSource([1.5])).toThrow("out of range");
    });

    it("UT-RAND-013: rejects NaN", () => {
      expect(() => new SequenceRandomSource([NaN])).toThrow("out of range");
    });

    it("UT-RAND-014: rejects Infinity", () => {
      expect(() => new SequenceRandomSource([Infinity])).toThrow("out of range");
    });

    it("UT-RAND-015: reports the index of the invalid value", () => {
      expect(() => new SequenceRandomSource([0.5, 0.3, 1.0])).toThrow("index 2");
    });

    it("UT-RAND-016: mutating source array after construction does not affect returned values", () => {
      const values = [0.5];
      const src = new SequenceRandomSource(values);
      values[0] = 1;
      expect(src.next()).toBe(0.5);
    });
  });
});
