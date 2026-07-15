import type {
  ErrorResponseBody,
  UiApiError,
  UiApiErrorKind,
  ViolationResponseBody,
} from "./api-contract.js";

// docs/ui-design/03_API・データ連携設計.md §13: エラー正規化.
// 既知のHTTP失敗をthrowだけで表現せず、判別可能なUiApiErrorへ正規化する。

const KIND_BY_CODE: Readonly<Record<string, UiApiErrorKind>> = {
  MALFORMED_REQUEST: "SERVER",
  NOT_ACCEPTABLE: "SERVER",
  REQUEST_TOO_LARGE: "SERVER",
  UNSUPPORTED_MEDIA_TYPE: "SERVER",
  INVALID_COMMAND: "VALIDATION",
  DEFINITION_NOT_FOUND: "VALIDATION",
  UNSUPPORTED_RULE: "UNSUPPORTED_DEFINITION",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT",
  INVALID_DEFINITION: "SERVER",
  DOMAIN_RULE_VIOLATION: "SERVER",
  EXECUTION_LIMIT_EXCEEDED: "SERVER",
  EXECUTION_TIMEOUT: "TIMEOUT",
  EXECUTION_CANCELLED: "CANCELLED",
  INTERNAL_INVARIANT_VIOLATION: "SERVER",
  CAPACITY_EXCEEDED: "CAPACITY",
};

function kindByStatus(status: number): UiApiErrorKind {
  if (status === 429) {
    return "RATE_LIMIT";
  }
  if (status === 503) {
    return "CAPACITY";
  }
  if (status === 504) {
    return "TIMEOUT";
  }
  return "SERVER";
}

function isErrorResponseBody(body: unknown): body is ErrorResponseBody {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const error = (body as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string" &&
    Array.isArray((error as { violations?: unknown }).violations)
  );
}

export interface NormalizeHttpErrorResponseOptions {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;
}

export function normalizeHttpErrorResponse(options: NormalizeHttpErrorResponseOptions): UiApiError {
  const { status, body, retryAfterSeconds } = options;

  if (!isErrorResponseBody(body)) {
    return {
      kind: kindByStatus(status),
      message: `Request failed with HTTP ${status.toString()}.`,
      status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  const { code, message, violations, diagnosticId } = body.error;
  const kind = KIND_BY_CODE[code] ?? kindByStatus(status);
  const violationsList: readonly ViolationResponseBody[] = violations;

  return {
    kind,
    message,
    status,
    code,
    ...(diagnosticId !== undefined ? { diagnosticId } : {}),
    ...(violationsList.length > 0 ? { violations: violationsList } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

export interface NormalizeRequestExceptionOptions {
  readonly timedOut: boolean;
}

export function normalizeRequestException(
  error: unknown,
  options: NormalizeRequestExceptionOptions,
): UiApiError {
  const isAbort =
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
  if (isAbort) {
    return options.timedOut
      ? { kind: "TIMEOUT", message: "The request did not complete before the client timeout." }
      : { kind: "CANCELLED", message: "The request was cancelled." };
  }

  if (error instanceof TypeError) {
    return {
      kind: "CORS_OR_NETWORK",
      message: "The request could not reach the API. This may be a network or CORS failure.",
    };
  }

  return { kind: "SERVER", message: "An unexpected client-side error occurred." };
}

const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;
const RETRY_AFTER_INTEGER_LIKE_PATTERN = /^-?\d+$/;

export function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (headerValue === null) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (RETRY_AFTER_SECONDS_PATTERN.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  // Reject integer-like strings before falling through to Date.parse, which
  // otherwise interprets values like "-5" as an ambiguous partial date.
  if (RETRY_AFTER_INTEGER_LIKE_PATTERN.test(trimmed)) {
    return undefined;
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) {
    return undefined;
  }

  const deltaSeconds = Math.round((parsedDate - Date.now()) / 1000);
  return Math.max(0, deltaSeconds);
}
