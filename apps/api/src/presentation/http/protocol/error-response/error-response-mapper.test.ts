import { describe, expect, it } from "vitest";
import {
  httpStatusForErrorCode,
  toErrorResponseBody,
  toExternalViolationPath,
  fromApplicationError,
} from "./error-response-mapper.js";
import { ApplicationError } from "../../../../application/contracts/application-error.js";

describe("httpStatusForErrorCode", () => {
  // `10_API設計.md`「ステータスコード対応」の正本テーブル。
  it.each([
    ["MALFORMED_REQUEST", 400],
    ["NOT_ACCEPTABLE", 406],
    ["REQUEST_TOO_LARGE", 413],
    ["UNSUPPORTED_MEDIA_TYPE", 415],
    ["INVALID_COMMAND", 422],
    ["DEFINITION_NOT_FOUND", 422],
    ["UNSUPPORTED_RULE", 422],
    ["RATE_LIMIT_EXCEEDED", 429],
    ["INVALID_DEFINITION", 500],
    ["INTERNAL_INVARIANT_VIOLATION", 500],
    ["CAPACITY_EXCEEDED", 503],
    ["EXECUTION_LIMIT_EXCEEDED", 503],
    ["EXECUTION_CANCELLED", 503],
    ["EXECUTION_TIMEOUT", 504],
  ] as const)("API-ERR-STATUS-%#: %s -> %i", (code, status) => {
    expect(httpStatusForErrorCode(code)).toBe(status);
  });
});

describe("toErrorResponseBody", () => {
  it("API-ERR-001: wraps code/message/violations/diagnosticId under schemaVersion 1 (10_API設計.md ErrorResponse)", () => {
    const body = toErrorResponseBody("INVALID_COMMAND", [
      { path: "/turnLimit", reason: "must be an integer between 1 and 99, got 0" },
    ]);

    expect(body.schemaVersion).toBe(1);
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations).toEqual([
      { path: "/turnLimit", message: "must be an integer between 1 and 99, got 0" },
    ]);
  });

  it("API-ERR-002: renames Violation.reason to ViolationResponseBody.message and preserves path/definitionId/ruleId only when present", () => {
    const body = toErrorResponseBody("UNSUPPORTED_RULE", [
      { ruleId: "CAP_X", definitionId: "UNIT_1", reason: "requires unimplemented capability" },
    ]);

    expect(body.error.violations).toEqual([
      { ruleId: "CAP_X", definitionId: "UNIT_1", message: "requires unimplemented capability" },
    ]);
  });

  it("API-ERR-003: defaults to an empty violations array and omits diagnosticId when not given", () => {
    const body = toErrorResponseBody("NOT_ACCEPTABLE", []);

    expect(body.error.violations).toEqual([]);
    expect(body.error).not.toHaveProperty("diagnosticId");
  });
});

describe("toExternalViolationPath", () => {
  // Application/DomainのCommand内部path形式(dot + `[index]`, `slots`表現)を
  // `10_API設計.md`の外部DTO形式(JSON Pointer, `units`表現)へ変換する。
  it.each([
    ["turnLimit", "/turnLimit"],
    ["logLevel", "/options/logLevel"],
    ["allyFormation.slots", "/allyFormation/units"],
    ["allyFormation.slots[0].position", "/allyFormation/units/0/position"],
    ["allyFormation.slots[2].position.column", "/allyFormation/units/2/position/column"],
    ["enemyFormation.slots[0].position.row", "/enemyFormation/units/0/position/row"],
    ["allyFormation.memoryDefinitionIds", "/allyFormation/memoryDefinitionIds"],
    ["allyFormation.memoryDefinitionIds[1]", "/allyFormation/memoryDefinitionIds/1"],
    ["allyFormation.slots[0].unitDefinitionId", "/allyFormation/units/0/unitDefinitionId"],
  ])("API-ERR-PATH-%#: %s -> %s", (internalPath, externalPointer) => {
    expect(toExternalViolationPath(internalPath)).toBe(externalPointer);
  });

  it("API-ERR-PATH-escaping: escapes literal '~' and '/' per RFC 6901 for segments that do not match the known dot/bracket shape", () => {
    expect(toExternalViolationPath("a~b/c")).toBe("/a~0b~1c");
  });
});

describe("fromApplicationError", () => {
  it("API-ERR-004: derives status 422, the code, and converts the internal Command path into an external JSON Pointer for an ApplicationError(INVALID_COMMAND)", () => {
    const error = new ApplicationError("INVALID_COMMAND", [
      { path: "allyFormation.slots[0].position.column", reason: "bad" },
    ]);

    const { status, body } = fromApplicationError(error);

    expect(status).toBe(422);
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations).toEqual([
      { path: "/allyFormation/units/0/position/column", message: "bad" },
    ]);
  });

  it("API-ERR-004b: leaves definitionId/ruleId-only violations (no path) untouched", () => {
    const error = new ApplicationError("DEFINITION_NOT_FOUND", [
      {
        path: "allyFormation.slots[0].unitDefinitionId",
        definitionId: "UNIT_MISSING",
        reason: "unknown",
      },
    ]);

    const { body } = fromApplicationError(error);

    expect(body.error.violations).toEqual([
      {
        path: "/allyFormation/units/0/unitDefinitionId",
        definitionId: "UNIT_MISSING",
        message: "unknown",
      },
    ]);
  });

  it("API-ERR-005: derives status 500 from an ApplicationError(INTERNAL_INVARIANT_VIOLATION)", () => {
    const error = new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [{ reason: "broken" }]);

    const { status } = fromApplicationError(error);

    expect(status).toBe(500);
  });

  it("API-ERR-006 (10_API設計.md「ErrorObject」diagnosticId): generates a diagnosticId for a 500-status ApplicationError that did not already carry one, so operators can correlate the response with server logs", () => {
    const error = new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [{ reason: "broken" }]);

    const { status, body } = fromApplicationError(error);

    expect(status).toBe(500);
    expect(body.error.diagnosticId).toEqual(expect.any(String));
    expect(body.error.diagnosticId!.length).toBeGreaterThan(0);
  });

  it("API-ERR-007: preserves an ApplicationError's own diagnosticId instead of overwriting it", () => {
    const error = new ApplicationError(
      "INTERNAL_INVARIANT_VIOLATION",
      [{ reason: "broken" }],
      "diag-existing",
    );

    const { body } = fromApplicationError(error);

    expect(body.error.diagnosticId).toBe("diag-existing");
  });

  it("API-ERR-008: does not fabricate a diagnosticId for non-500 errors (client input violations do not need server-log correlation)", () => {
    const error = new ApplicationError("INVALID_COMMAND", [{ path: "turnLimit", reason: "bad" }]);

    const { body } = fromApplicationError(error);

    expect(body.error).not.toHaveProperty("diagnosticId");
  });
});
