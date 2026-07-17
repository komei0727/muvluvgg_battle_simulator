import { randomUUID } from "node:crypto";
import type {
  ApplicationError,
  ApplicationErrorCode,
  Violation,
} from "../../application/contracts/application-error.js";
import type {
  ErrorResponseBody,
  ViolationResponseBody,
} from "../../application/contracts/error.js";

const SERVER_LOG_CORRELATION_STATUS = 500;

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

/**
 * `10_API設計.md`「Inbound Adapterでの変換」で定義される内部⇔外部の名前対応。
 * `SimulateBattleCommand`の`slots`は外部DTOでは`units`と呼ぶ。
 */
const RENAMED_PATH_SEGMENTS: Readonly<Record<string, string>> = { slots: "units" };

const PATH_SEGMENT_PATTERN = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/;

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * `simulate-battle-command.ts`/`simulation-preflight-validator.ts`/
 * Domainの`DomainValidationError`が使うCommand内部path形式
 * （ドット区切り、配列は`name[index]`、`slots`表現）を、
 * `10_API設計.md`「ViolationResponse」が要求するJSON Pointer形式（`/`区切り、
 * 配列indexは独立segment、`units`表現）へ変換する。
 *
 * `logLevel`はCommand上はトップレベルの平坦な項目だが、外部DTOでは
 * `options.logLevel`にネストされるため、名前の付け替えではなく特別に
 * 1階層挿入する。
 */
export function toExternalViolationPath(internalPath: string): string {
  if (internalPath === "logLevel") {
    return "/options/logLevel";
  }

  const pointerSegments: string[] = [];
  for (const segment of internalPath.split(".")) {
    const match = PATH_SEGMENT_PATTERN.exec(segment);
    if (match === null) {
      pointerSegments.push(escapeJsonPointerSegment(segment));
      continue;
    }
    const [, name, arrayIndex] = match;
    const externalName = RENAMED_PATH_SEGMENTS[name!] ?? name!;
    pointerSegments.push(escapeJsonPointerSegment(externalName));
    if (arrayIndex !== undefined) {
      pointerSegments.push(arrayIndex);
    }
  }
  return `/${pointerSegments.join("/")}`;
}

function toViolationResponseBody(
  violation: Violation,
  translatePath: (path: string) => string = (path) => path,
): ViolationResponseBody {
  return {
    ...(violation.path !== undefined ? { path: translatePath(violation.path) } : {}),
    ...(violation.definitionId !== undefined ? { definitionId: violation.definitionId } : {}),
    ...(violation.ruleId !== undefined ? { ruleId: violation.ruleId } : {}),
    message: violation.reason,
  };
}

function buildErrorResponseBody(
  code: HttpErrorCode,
  violations: readonly Violation[],
  translatePath: (path: string) => string,
  diagnosticId?: string,
): ErrorResponseBody {
  return {
    schemaVersion: 1,
    error: {
      code,
      message: DEFAULT_MESSAGE_BY_CODE[code],
      violations: violations.map((violation) => toViolationResponseBody(violation, translatePath)),
      ...(diagnosticId !== undefined ? { diagnosticId } : {}),
    },
  };
}

/**
 * `10_API設計.md`「ErrorResponse」: 成功レスポンスとは別の本文形。呼び出し元
 * （Fastifyのcontent-type/validationエラーなど）が既に外部DTO形式のpathを
 * 渡す前提のため、ここではpath変換を行わない
 * （内部Command pathの変換は`fromApplicationError`が担う）。
 */
export function toErrorResponseBody(
  code: HttpErrorCode,
  violations: readonly Violation[],
  diagnosticId?: string,
): ErrorResponseBody {
  return buildErrorResponseBody(code, violations, (path) => path, diagnosticId);
}

/**
 * `ApplicationError`（UseCaseから送出される唯一の失敗形）をHTTPステータス＋
 * 本文へ変換する。`violations[].path`はCommand内部形式のため、
 * `toExternalViolationPath`で外部DTOのJSON Pointerへ変換する。
 *
 * `10_API設計.md`「ErrorObject」: `diagnosticId`は「サーバーログと照合するID」。
 * 500（サーバー側の予期しない不変条件違反）はオペレーターがログを辿れる
 * 必要があるため、`ApplicationError`自身がIDを持たない場合はここで生成する。
 * 400〜429（クライアント入力由来の既知の違反）は`violations`が原因を
 * 説明済みであり、ログ照合の必要が薄いためIDを付与しない。
 */
export function fromApplicationError(error: ApplicationError): {
  status: number;
  body: ErrorResponseBody;
} {
  const code: ApplicationErrorCode = error.code;
  const status = httpStatusForErrorCode(code);
  const diagnosticId =
    status === SERVER_LOG_CORRELATION_STATUS
      ? (error.diagnosticId ?? randomUUID())
      : error.diagnosticId;
  return {
    status,
    body: buildErrorResponseBody(code, error.violations, toExternalViolationPath, diagnosticId),
  };
}
