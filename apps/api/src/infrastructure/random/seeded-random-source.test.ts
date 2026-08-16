import { describe, expect, it } from "vitest";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import {
  deriveRunSeed,
  hashSeedString,
  Mulberry32RandomSource,
  Mulberry32SeededRandomSourceProvider,
} from "./seeded-random-source.js";

describe("Mulberry32RandomSource", () => {
  it("UT-SEEDRAND-001: the same seed reproduces the same sequence", () => {
    const first = new Mulberry32RandomSource(12345);
    const second = new Mulberry32RandomSource(12345);

    const firstValues = Array.from({ length: 32 }, () => first.next());
    const secondValues = Array.from({ length: 32 }, () => second.next());

    expect(secondValues).toEqual(firstValues);
  });

  it("UT-SEEDRAND-002: different seeds produce different sequences", () => {
    const first = new Mulberry32RandomSource(1);
    const second = new Mulberry32RandomSource(2);

    const firstValues = Array.from({ length: 32 }, () => first.next());
    const secondValues = Array.from({ length: 32 }, () => second.next());

    expect(secondValues).not.toEqual(firstValues);
  });

  it("UT-SEEDRAND-003: next() stays within the domain RandomSource contract [0, 1)", () => {
    const source = new Mulberry32RandomSource(0);

    for (let i = 0; i < 10000; i++) {
      const value = source.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("hashSeedString", () => {
  it("UT-SEEDRAND-004: the same seed string always hashes to the same value", () => {
    expect(hashSeedString("abc123")).toBe(hashSeedString("abc123"));
    expect(hashSeedString("")).toBe(hashSeedString(""));
  });

  it("UT-SEEDRAND-005: different seed strings hash to different values", () => {
    const hashes = new Set(
      ["", "a", "b", "abc123", "abc124", "seed-1", "seed-2"].map((seed) => hashSeedString(seed)),
    );

    expect(hashes.size).toBe(7);
  });

  it("UT-SEEDRAND-006: the hash is an unsigned 32-bit integer", () => {
    for (const seed of ["", "a", "abc123", "とても長いシード文字列".repeat(20)]) {
      const hash = hashSeedString(seed);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("deriveRunSeed", () => {
  it("UT-SEEDRAND-007: the same (baseSeed, runIndex) always derives the same run seed", () => {
    expect(deriveRunSeed(42, 7)).toBe(deriveRunSeed(42, 7));
    expect(deriveRunSeed(0, 0)).toBe(deriveRunSeed(0, 0));
  });

  it("UT-SEEDRAND-008: consecutive run indices derive distinct run seeds", () => {
    const seeds = new Set(
      Array.from({ length: 1000 }, (_, runIndex) => deriveRunSeed(42, runIndex)),
    );

    expect(seeds.size).toBe(1000);
  });

  it("UT-SEEDRAND-009: different base seeds derive different run seeds for the same run index", () => {
    expect(deriveRunSeed(1, 5)).not.toBe(deriveRunSeed(2, 5));
  });

  it("UT-SEEDRAND-010: the derived run seed is an unsigned 32-bit integer", () => {
    for (const runIndex of [0, 1, 999, 0xffff]) {
      const seed = deriveRunSeed(0xdeadbeef, runIndex);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("Mulberry32SeededRandomSourceProvider", () => {
  const provider = new Mulberry32SeededRandomSourceProvider();

  function take(factory: RandomSourceFactory, count: number): number[] {
    const source = factory.create();
    return Array.from({ length: count }, () => source.next());
  }

  it("UT-SEEDRAND-011: the same (seed, runIndex) reproduces the same stream", () => {
    expect(take(provider.forRun("abc123", 3), 16)).toEqual(take(provider.forRun("abc123", 3), 16));
  });

  it("UT-SEEDRAND-012: different run indices of one seed produce different streams", () => {
    expect(take(provider.forRun("abc123", 0), 16)).not.toEqual(
      take(provider.forRun("abc123", 1), 16),
    );
  });

  it("UT-SEEDRAND-013: different seeds produce different streams for the same run index", () => {
    expect(take(provider.forRun("seed-1", 4), 16)).not.toEqual(
      take(provider.forRun("seed-2", 4), 16),
    );
  });

  it("UT-SEEDRAND-014: each create() returns a fresh RandomSource replaying the same stream (09_アプリケーション設計.md「Battleごとに専用のRandomSourceを生成する」)", () => {
    const factory = provider.forRun("abc123", 0);

    const first = factory.create();
    const firstValues = Array.from({ length: 8 }, () => first.next());

    // Created only after `first` was consumed: the factory must not carry consumption state,
    // otherwise a batch would silently drift away from the reproducible stream.
    const second = factory.create();

    expect(second).not.toBe(first);
    expect(Array.from({ length: 8 }, () => second.next())).toEqual(firstValues);
  });
});

describe("deriveRunSeed argument range", () => {
  it("UT-SEEDRAND-015: a non-integer runIndex is rejected instead of colliding with its truncation", () => {
    expect(() => deriveRunSeed(42, 0.5)).toThrow(RangeError);
  });

  it("UT-SEEDRAND-016: a negative runIndex is rejected", () => {
    expect(() => deriveRunSeed(42, -1)).toThrow(RangeError);
  });

  it("UT-SEEDRAND-017: a runIndex beyond the unsigned 32-bit range is rejected", () => {
    expect(() => deriveRunSeed(42, 2 ** 32)).toThrow(RangeError);
  });

  it("UT-SEEDRAND-018: a baseSeed outside the unsigned 32-bit range is rejected", () => {
    expect(() => deriveRunSeed(2 ** 32, 5)).toThrow(RangeError);
    expect(() => deriveRunSeed(-1, 5)).toThrow(RangeError);
  });

  it("UT-SEEDRAND-019: both ends of the accepted runIndex range are usable and stay distinct", () => {
    expect(deriveRunSeed(42, 0)).not.toBe(deriveRunSeed(42, 0xffffffff));
  });
});

describe("Mulberry32SeededRandomSourceProvider argument range", () => {
  it("UT-SEEDRAND-020: forRun rejects a runIndex the uniqueness contract cannot cover", () => {
    const provider = new Mulberry32SeededRandomSourceProvider();

    expect(() => provider.forRun("abc123", 2 ** 32)).toThrow(RangeError);
    expect(() => provider.forRun("abc123", 0.5)).toThrow(RangeError);
    expect(() => provider.forRun("abc123", -1)).toThrow(RangeError);
  });
});
