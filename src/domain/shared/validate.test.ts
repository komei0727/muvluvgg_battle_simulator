import { describe, expect, it } from "vitest";
import { DomainValidationError } from "./errors.js";
import {
  assertArray,
  assertBoolean,
  assertNonEmptyArray,
  assertNullableInteger,
  assertNullableString,
  assertString,
} from "./validate.js";

describe("Shared validate helpers", () => {
  it("UT-SHARED-VALIDATE-001: assertArray accepts arrays and rejects non-arrays", () => {
    expect(() => assertArray([], "field")).not.toThrow();
    expect(() => assertArray("not-an-array", "field")).toThrow(DomainValidationError);
    expect(() => assertArray({ length: 0 }, "field")).toThrow(DomainValidationError);
    expect(() => assertArray(undefined, "field")).toThrow(DomainValidationError);
  });

  it("UT-SHARED-VALIDATE-002: assertNonEmptyArray rejects non-arrays before checking length", () => {
    expect(() => assertNonEmptyArray("abc", "field")).toThrow(DomainValidationError);
    expect(() => assertNonEmptyArray([], "field")).toThrow(DomainValidationError);
    expect(() => assertNonEmptyArray([1], "field")).not.toThrow();
  });

  it("UT-SHARED-VALIDATE-003: assertBoolean accepts only real booleans", () => {
    expect(() => assertBoolean(true, "field")).not.toThrow();
    expect(() => assertBoolean(false, "field")).not.toThrow();
    expect(() => assertBoolean("true", "field")).toThrow(DomainValidationError);
    expect(() => assertBoolean(1, "field")).toThrow(DomainValidationError);
    expect(() => assertBoolean(undefined, "field")).toThrow(DomainValidationError);
  });

  it("UT-SHARED-VALIDATE-004: assertString accepts only strings", () => {
    expect(() => assertString("ok", "field")).not.toThrow();
    expect(() => assertString(1, "field")).toThrow(DomainValidationError);
  });

  it("UT-SHARED-VALIDATE-005: assertNullableInteger accepts null, rejects wrong type, enforces range", () => {
    expect(() => assertNullableInteger(null, "field")).not.toThrow();
    expect(() => assertNullableInteger(2, "field", { min: 1 })).not.toThrow();
    expect(() => assertNullableInteger(0, "field", { min: 1 })).toThrow(DomainValidationError);
    expect(() => assertNullableInteger("2", "field")).toThrow(DomainValidationError);
    expect(() => assertNullableInteger(1.5, "field")).toThrow(DomainValidationError);
  });

  it("UT-SHARED-VALIDATE-006: assertNullableString accepts null, rejects wrong type", () => {
    expect(() => assertNullableString(null, "field")).not.toThrow();
    expect(() => assertNullableString("ok", "field")).not.toThrow();
    expect(() => assertNullableString(1, "field")).toThrow(DomainValidationError);
  });
});
