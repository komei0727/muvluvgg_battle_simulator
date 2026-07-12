import { describe, expect, it } from "vitest";
import { ApplicationError } from "./application-error.js";

describe("ApplicationError", () => {
  it("UT-APP-ERROR-001: carries the code, violations, and an optional diagnosticId", () => {
    const error = new ApplicationError(
      "INVALID_COMMAND",
      [{ path: "turnLimit", reason: "must be between 1 and 99" }],
      "diag-1",
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations).toEqual([{ path: "turnLimit", reason: "must be between 1 and 99" }]);
    expect(error.diagnosticId).toBe("diag-1");
    expect(error).toBeInstanceOf(Error);
  });

  it("UT-APP-ERROR-002: joins every violation's reason into the error message", () => {
    const error = new ApplicationError("DEFINITION_NOT_FOUND", [
      { path: "allyFormation.slots[0]", reason: "unknown UnitDefinitionId" },
      { path: "enemyFormation.slots[1]", reason: "unknown UnitDefinitionId" },
    ]);

    expect(error.message).toBe(
      "DEFINITION_NOT_FOUND: unknown UnitDefinitionId; unknown UnitDefinitionId",
    );
  });
});
