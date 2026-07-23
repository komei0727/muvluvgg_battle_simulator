import { describe, expect, it } from "vitest";
import { compareWithOperator } from "./comparison-operator.js";

describe("compareWithOperator", () => {
  it("UT-COMPARISON-OPERATOR-001: GT/GTE/LT/LTE only match when both sides are numbers", () => {
    expect(compareWithOperator(5, "GT", 3)).toBe(true);
    expect(compareWithOperator(3, "GT", 5)).toBe(false);
    expect(compareWithOperator("5", "GT", 3)).toBe(false);
    expect(compareWithOperator(5, "GTE", 5)).toBe(true);
    expect(compareWithOperator(3, "LT", 5)).toBe(true);
    expect(compareWithOperator(5, "LTE", 5)).toBe(true);
  });

  it("UT-COMPARISON-OPERATOR-002: EQ/NEQ use strict equality on any JsonPrimitive", () => {
    expect(compareWithOperator("MISSED", "EQ", "MISSED")).toBe(true);
    expect(compareWithOperator("MISSED", "EQ", "APPLIED")).toBe(false);
    expect(compareWithOperator(true, "NEQ", false)).toBe(true);
  });

  it("UT-COMPARISON-OPERATOR-003: IN checks expected array contains actual, CONTAINS checks actual array contains expected", () => {
    expect(compareWithOperator("APPLIED", "IN", ["APPLIED", "SKIPPED"] as unknown as never)).toBe(
      true,
    );
    expect(compareWithOperator("MISSED", "IN", ["APPLIED", "SKIPPED"] as unknown as never)).toBe(
      false,
    );
    expect(compareWithOperator(["A", "B"], "CONTAINS", "A")).toBe(true);
    expect(compareWithOperator(["A", "B"], "CONTAINS", "C")).toBe(false);
  });
});
