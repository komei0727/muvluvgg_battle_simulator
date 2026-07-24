import { describe, expect, it } from "vitest";
import { compareWithOperator } from "./comparison-operator.js";

describe("compareWithOperator", () => {
  it("UT-CMP-OP-001: GT/GTE/LT/LTE compare numbers only", () => {
    expect(compareWithOperator(5, "GT", 3)).toBe(true);
    expect(compareWithOperator(3, "GT", 3)).toBe(false);
    expect(compareWithOperator(3, "GTE", 3)).toBe(true);
    expect(compareWithOperator(2, "LT", 3)).toBe(true);
    expect(compareWithOperator(3, "LTE", 3)).toBe(true);
  });

  it("UT-CMP-OP-002: numeric operators are false for non-number operands", () => {
    expect(compareWithOperator("5", "GT", 3)).toBe(false);
    expect(compareWithOperator(5, "GT", "3")).toBe(false);
  });

  it("UT-CMP-OP-003: EQ/NEQ use strict equality", () => {
    expect(compareWithOperator("APPLIED", "EQ", "APPLIED")).toBe(true);
    expect(compareWithOperator("APPLIED", "EQ", "MISSED")).toBe(false);
    expect(compareWithOperator("APPLIED", "NEQ", "MISSED")).toBe(true);
  });

  it("UT-CMP-OP-004: IN checks that expected array contains actual", () => {
    const applied = ["APPLIED", "MISSED"] as unknown as string;
    expect(compareWithOperator("MISSED", "IN", applied)).toBe(true);
    expect(compareWithOperator("REJECTED", "IN", applied)).toBe(false);
  });

  it("UT-CMP-OP-005: CONTAINS checks that actual array contains expected", () => {
    expect(compareWithOperator(["u1", "u2"], "CONTAINS", "u2")).toBe(true);
    expect(compareWithOperator(["u1", "u2"], "CONTAINS", "u3")).toBe(false);
    expect(compareWithOperator("not-an-array", "CONTAINS", "u2")).toBe(false);
  });
});
