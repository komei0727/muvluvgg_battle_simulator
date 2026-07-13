import { describe, expect, it } from "vitest";
import { SequenceRandomSourceFactory } from "./sequence-random-source-factory.js";

describe("SequenceRandomSourceFactory", () => {
  it("UT-TESTING-RANDOM-FACTORY-001: each create() returns an independent RandomSource seeded with the same preset values", () => {
    const factory = new SequenceRandomSourceFactory([0.1, 0.2]);

    const first = factory.create();
    const second = factory.create();

    expect(first.next()).toBeCloseTo(0.1);
    expect(first.next()).toBeCloseTo(0.2);
    // A fresh instance starts its own sequence from the beginning, independent of `first`'s consumption.
    expect(second.next()).toBeCloseTo(0.1);
  });

  it("UT-TESTING-RANDOM-FACTORY-002: a RandomSource created from an empty sequence throws immediately when consumed", () => {
    const factory = new SequenceRandomSourceFactory([]);

    const random = factory.create();

    expect(() => random.next()).toThrow(/exhausted/);
  });
});
