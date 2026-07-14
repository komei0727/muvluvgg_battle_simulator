import { describe, expect, it } from "vitest";
import { SystemRandomSource, SystemRandomSourceFactory } from "./system-random-source.js";

describe("SystemRandomSource", () => {
  it("UT-SYSRAND-001: next() returns values within the domain RandomSource contract [0, 1)", () => {
    const source = new SystemRandomSource();
    for (let i = 0; i < 1000; i++) {
      const value = source.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("SystemRandomSourceFactory", () => {
  it("UT-SYSRAND-002: create() returns a usable RandomSource", () => {
    const factory = new SystemRandomSourceFactory();
    const source = factory.create();
    expect(source.next()).toBeGreaterThanOrEqual(0);
    expect(source.next()).toBeLessThan(1);
  });

  it("UT-SYSRAND-003: create() returns a fresh instance on each call (09_アプリケーション設計.md「Battleごとに専用のRandomSourceを生成する」)", () => {
    const factory = new SystemRandomSourceFactory();
    expect(factory.create()).not.toBe(factory.create());
  });
});
