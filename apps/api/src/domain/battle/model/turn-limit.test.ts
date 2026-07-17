import { describe, expect, it } from "vitest";
import { createTurnLimit } from "./turn-limit.js";
import { DomainValidationError } from "../../shared/errors.js";

describe("TurnLimit (R-FRM-05)", () => {
  it("UT-R-FRM-05-001: accepts the lower bound 1", () => {
    expect(createTurnLimit(1)).toBe(1);
  });

  it("UT-R-FRM-05-002: accepts the upper bound 99", () => {
    expect(createTurnLimit(99)).toBe(99);
  });

  it("UT-R-FRM-05-003: rejects 0", () => {
    expect(() => createTurnLimit(0)).toThrow(DomainValidationError);
  });

  it("UT-R-FRM-05-004: rejects 100", () => {
    expect(() => createTurnLimit(100)).toThrow(DomainValidationError);
  });

  it("UT-R-FRM-05-005: rejects a non-integer value", () => {
    expect(() => createTurnLimit(5.5)).toThrow(DomainValidationError);
  });
});
