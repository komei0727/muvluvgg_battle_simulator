import { describe, expect, it } from "vitest";
import {
  httpStatusForErrorCode,
  toErrorResponseBody,
  fromApplicationError,
} from "./error-response-mapper.js";
import { ApplicationError } from "../../application/application-error.js";

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

describe("fromApplicationError", () => {
  it("API-ERR-004: derives status 422 and the code/violations from an ApplicationError(INVALID_COMMAND)", () => {
    const error = new ApplicationError("INVALID_COMMAND", [{ path: "/turnLimit", reason: "bad" }]);

    const { status, body } = fromApplicationError(error);

    expect(status).toBe(422);
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations).toEqual([{ path: "/turnLimit", message: "bad" }]);
  });

  it("API-ERR-005: derives status 500 from an ApplicationError(INTERNAL_INVARIANT_VIOLATION)", () => {
    const error = new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [{ reason: "broken" }]);

    const { status } = fromApplicationError(error);

    expect(status).toBe(500);
  });
});
