import { describe, expect, it } from "vitest";
import {
  normalizeHttpErrorResponse,
  normalizeRequestException,
  parseRetryAfterSeconds,
} from "./error-normalizer.js";

describe("parseRetryAfterSeconds", () => {
  // UI-UT-API-003
  it("parses a delay-seconds header value", () => {
    expect(parseRetryAfterSeconds("120")).toBe(120);
  });

  it("accepts zero", () => {
    expect(parseRetryAfterSeconds("0")).toBe(0);
  });

  it("returns undefined for a missing header", () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
  });

  it("returns undefined for a non-numeric, non-date value", () => {
    expect(parseRetryAfterSeconds("not-a-value")).toBeUndefined();
  });

  it("returns undefined for a negative delay", () => {
    expect(parseRetryAfterSeconds("-5")).toBeUndefined();
  });

  it("parses an HTTP-date in the future as a non-negative delay", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();

    const result = parseRetryAfterSeconds(future);

    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(31);
  });

  it("clamps an HTTP-date already in the past to zero", () => {
    const past = new Date(Date.now() - 30_000).toUTCString();

    expect(parseRetryAfterSeconds(past)).toBe(0);
  });
});

describe("normalizeRequestException", () => {
  // UI-UT-API-005
  it("classifies an AbortError as CANCELLED when the UI timeout did not fire", () => {
    const abortError = new DOMException("aborted", "AbortError");

    const result = normalizeRequestException(abortError, { timedOut: false });

    expect(result.kind).toBe("CANCELLED");
  });

  it("classifies an AbortError as TIMEOUT when the UI timeout fired", () => {
    const abortError = new DOMException("aborted", "AbortError");

    const result = normalizeRequestException(abortError, { timedOut: true });

    expect(result.kind).toBe("TIMEOUT");
  });

  // UI-UT-API-006
  it("classifies a fetch TypeError as CORS_OR_NETWORK without asserting the cause", () => {
    const typeError = new TypeError("Failed to fetch");

    const result = normalizeRequestException(typeError, { timedOut: false });

    expect(result.kind).toBe("CORS_OR_NETWORK");
  });

  it("falls back to SERVER for an unrecognized exception shape", () => {
    const result = normalizeRequestException("unexpected", { timedOut: false });

    expect(result.kind).toBe("SERVER");
  });
});

describe("normalizeHttpErrorResponse", () => {
  it("maps 429 RATE_LIMIT_EXCEEDED to RATE_LIMIT and carries retryAfterSeconds", () => {
    const result = normalizeHttpErrorResponse({
      status: 429,
      body: {
        schemaVersion: 1,
        error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests.", violations: [] },
      },
      retryAfterSeconds: 30,
    });

    expect(result.kind).toBe("RATE_LIMIT");
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("maps 503 CAPACITY_EXCEEDED to CAPACITY", () => {
    const result = normalizeHttpErrorResponse({
      status: 503,
      body: {
        schemaVersion: 1,
        error: { code: "CAPACITY_EXCEEDED", message: "Server busy.", violations: [] },
      },
    });

    expect(result.kind).toBe("CAPACITY");
  });

  it("maps 503 EXECUTION_CANCELLED to CANCELLED", () => {
    const result = normalizeHttpErrorResponse({
      status: 503,
      body: {
        schemaVersion: 1,
        error: { code: "EXECUTION_CANCELLED", message: "Cancelled.", violations: [] },
      },
    });

    expect(result.kind).toBe("CANCELLED");
  });

  it("maps 504 EXECUTION_TIMEOUT to TIMEOUT", () => {
    const result = normalizeHttpErrorResponse({
      status: 504,
      body: {
        schemaVersion: 1,
        error: { code: "EXECUTION_TIMEOUT", message: "Timed out.", violations: [] },
      },
    });

    expect(result.kind).toBe("TIMEOUT");
  });

  it("maps 500 to SERVER and carries diagnosticId", () => {
    const result = normalizeHttpErrorResponse({
      status: 500,
      body: {
        schemaVersion: 1,
        error: {
          code: "INTERNAL_INVARIANT_VIOLATION",
          message: "Unexpected.",
          violations: [],
          diagnosticId: "diag-123",
        },
      },
    });

    expect(result.kind).toBe("SERVER");
    expect(result.diagnosticId).toBe("diag-123");
  });

  it("maps 422 INVALID_COMMAND to VALIDATION and carries violations", () => {
    const violations = [{ path: "/turnLimit", message: "must be 1-99" }];

    const result = normalizeHttpErrorResponse({
      status: 422,
      body: {
        schemaVersion: 1,
        error: { code: "INVALID_COMMAND", message: "Invalid.", violations },
      },
    });

    expect(result.kind).toBe("VALIDATION");
    expect(result.violations).toEqual(violations);
  });

  it("maps 422 UNSUPPORTED_RULE to UNSUPPORTED_DEFINITION", () => {
    const result = normalizeHttpErrorResponse({
      status: 422,
      body: {
        schemaVersion: 1,
        error: { code: "UNSUPPORTED_RULE", message: "Unsupported.", violations: [] },
      },
    });

    expect(result.kind).toBe("UNSUPPORTED_DEFINITION");
  });

  it("falls back to a status-based mapping when the body is not a valid error envelope", () => {
    const result = normalizeHttpErrorResponse({ status: 503, body: null });

    expect(result.kind).toBe("CAPACITY");
  });

  it("falls back to SERVER for an unrecognized status and body", () => {
    const result = normalizeHttpErrorResponse({ status: 418, body: null });

    expect(result.kind).toBe("SERVER");
  });
});
