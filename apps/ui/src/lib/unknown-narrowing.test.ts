import { describe, expect, it } from "vitest";
import { isRecord, numberOf, stringOf } from "./unknown-narrowing.js";

describe("isRecord", () => {
  it("accepts a plain object", () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isRecord([1, 2])).toBe(false);
  });

  it("rejects primitives", () => {
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("numberOf", () => {
  it("returns the value for a number", () => {
    expect(numberOf(3)).toBe(3);
  });

  it("returns undefined for a non-number", () => {
    expect(numberOf("3")).toBeUndefined();
    expect(numberOf(null)).toBeUndefined();
  });

  // Callers narrow raw JSON, where NaN cannot appear; keeping the check to a
  // plain typeof avoids diverging from the per-file definitions it replaces.
  it("returns NaN as-is", () => {
    expect(numberOf(Number.NaN)).toBeNaN();
  });
});

describe("stringOf", () => {
  it("returns the value for a string", () => {
    expect(stringOf("x")).toBe("x");
  });

  it("returns undefined for a non-string", () => {
    expect(stringOf(1)).toBeUndefined();
    expect(stringOf(undefined)).toBeUndefined();
  });

  it("returns an empty string as-is", () => {
    expect(stringOf("")).toBe("");
  });
});
