import { describe, expect, it } from "vitest";
import { ApplicationError } from "../../application/application-error.js";
import { toApplicationError, toSerializedApplicationError } from "./worker-contract.js";

describe("worker-contract serialization", () => {
  it("UT-WORKERCONTRACT-001: toSerializedApplicationError() keeps code and violations, omits absent diagnosticId", () => {
    const error = new ApplicationError("INVALID_COMMAND", [
      { path: "turnLimit", reason: "must be positive" },
    ]);

    const serialized = toSerializedApplicationError(error);

    expect(serialized).toEqual({
      code: "INVALID_COMMAND",
      violations: [{ path: "turnLimit", reason: "must be positive" }],
    });
    expect(serialized).not.toHaveProperty("diagnosticId");
  });

  it("UT-WORKERCONTRACT-002: toSerializedApplicationError() carries diagnosticId when present", () => {
    const error = new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [], "diag-1");

    const serialized = toSerializedApplicationError(error);

    expect(serialized.diagnosticId).toBe("diag-1");
  });

  it("UT-WORKERCONTRACT-003: toApplicationError() round-trips a serialized error back into an ApplicationError", () => {
    const original = new ApplicationError("DEFINITION_NOT_FOUND", [
      { path: "allyFormation.slots[0].unitDefinitionId", reason: "unknown Unit definition" },
    ]);

    const restored = toApplicationError(toSerializedApplicationError(original));

    expect(restored).toBeInstanceOf(ApplicationError);
    expect(restored.code).toBe(original.code);
    expect(restored.violations).toEqual(original.violations);
    expect(restored.diagnosticId).toBeUndefined();
  });

  it("UT-WORKERCONTRACT-004: toApplicationError() round-trips a present diagnosticId", () => {
    const restored = toApplicationError({
      code: "INTERNAL_INVARIANT_VIOLATION",
      violations: [{ reason: "unexpected worker failure" }],
      diagnosticId: "diag-2",
    });

    expect(restored.diagnosticId).toBe("diag-2");
  });
});
