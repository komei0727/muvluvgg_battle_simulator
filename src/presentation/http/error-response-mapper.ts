import type {
  ApplicationError,
  ApplicationErrorCode,
  Violation,
} from "../../application/application-error.js";
import type { ErrorResponseBody, ViolationResponseBody } from "../../application/http-contract.js";

/**
 * `10_API設計.md`「ステータスコード対応」に、Fastify境界だけで発生する
 * 構造的エラー（`ApplicationErrorCode`には現れない、UseCase到達前に確定する
 * もの）を加えた完全な集合。
 */
export const HTTP_ERROR_CODES = [
  "MALFORMED_REQUEST",
  "NOT_ACCEPTABLE",
  "REQUEST_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INVALID_COMMAND",
  "DEFINITION_NOT_FOUND",
  "UNSUPPORTED_RULE",
  "RATE_LIMIT_EXCEEDED",
  "INVALID_DEFINITION",
  "DOMAIN_RULE_VIOLATION",
  "EXECUTION_LIMIT_EXCEEDED",
  "EXECUTION_TIMEOUT",
  "EXECUTION_CANCELLED",
  "INTERNAL_INVARIANT_VIOLATION",
  "CAPACITY_EXCEEDED",
] as const;
export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<HttpErrorCode, number> = {
  MALFORMED_REQUEST: 400,
  NOT_ACCEPTABLE: 406,
  REQUEST_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_COMMAND: 422,
  DEFINITION_NOT_FOUND: 422,
  UNSUPPORTED_RULE: 422,
  RATE_LIMIT_EXCEEDED: 429,
  INVALID_DEFINITION: 500,
  // `10_API設計.md`: 事前検証を通過した後に生じた予期しない不変条件違反として扱う
  // （このコードを実際に送出する経路は現時点では存在しない防御的なマッピング）。
  DOMAIN_RULE_VIOLATION: 500,
  INTERNAL_INVARIANT_VIOLATION: 500,
  CAPACITY_EXCEEDED: 503,
  EXECUTION_LIMIT_EXCEEDED: 503,
  EXECUTION_CANCELLED: 503,
  EXECUTION_TIMEOUT: 504,
};

const DEFAULT_MESSAGE_BY_CODE: Record<HttpErrorCode, string> = {
  MALFORMED_REQUEST: "The request body is not valid JSON or does not match the expected structure.",
  NOT_ACCEPTABLE: "The requested representation is not available.",
  REQUEST_TOO_LARGE: "The request body exceeds the allowed size.",
  UNSUPPORTED_MEDIA_TYPE: "The request Content-Type is not supported.",
  INVALID_COMMAND: "The request contains invalid battle conditions.",
  DEFINITION_NOT_FOUND: "The request references unknown Catalog definitions.",
  UNSUPPORTED_RULE: "The request requires unimplemented Capabilities.",
  RATE_LIMIT_EXCEEDED: "Too many requests.",
  INVALID_DEFINITION: "The server's Catalog definitions are inconsistent.",
  DOMAIN_RULE_VIOLATION: "An unexpected domain rule violation occurred.",
  INTERNAL_INVARIANT_VIOLATION: "An internal invariant was violated.",
  CAPACITY_EXCEEDED: "The server is at capacity.",
  EXECUTION_LIMIT_EXCEEDED: "The simulation exceeded its execution limits.",
  EXECUTION_TIMEOUT: "The simulation did not complete before the deadline.",
  EXECUTION_CANCELLED: "The simulation was cancelled.",
};

export function httpStatusForErrorCode(code: HttpErrorCode): number {
  return STATUS_BY_CODE[code];
}

function toViolationResponseBody(violation: Violation): ViolationResponseBody {
  return {
    ...(violation.path !== undefined ? { path: violation.path } : {}),
    ...(violation.definitionId !== undefined ? { definitionId: violation.definitionId } : {}),
    ...(violation.ruleId !== undefined ? { ruleId: violation.ruleId } : {}),
    message: violation.reason,
  };
}

/** `10_API設計.md`「ErrorResponse」: 成功レスポンスとは別の本文形。 */
export function toErrorResponseBody(
  code: HttpErrorCode,
  violations: readonly Violation[],
  diagnosticId?: string,
): ErrorResponseBody {
  return {
    schemaVersion: 1,
    error: {
      code,
      message: DEFAULT_MESSAGE_BY_CODE[code],
      violations: violations.map(toViolationResponseBody),
      ...(diagnosticId !== undefined ? { diagnosticId } : {}),
    },
  };
}

/** `ApplicationError`（UseCaseから送出される唯一の失敗形）をHTTPステータス＋本文へ変換する。 */
export function fromApplicationError(error: ApplicationError): {
  status: number;
  body: ErrorResponseBody;
} {
  const code: ApplicationErrorCode = error.code;
  return {
    status: httpStatusForErrorCode(code),
    body: toErrorResponseBody(code, error.violations, error.diagnosticId),
  };
}
