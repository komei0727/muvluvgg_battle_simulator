/**
 * Raised when data crossing the DTO/Domain boundary (Catalog definitions,
 * branded IDs) violates a Domain invariant. `path` locates the offending
 * field using dot/bracket notation relative to the DTO root being converted.
 */
export class DomainValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "DomainValidationError";
    this.path = path;
  }
}

/**
 * `09_アプリケーション設計.md`「実行保護」（`EXECUTION_LIMIT_EXCEEDED`）: イベント数・
 * PS深度・効果数などのSimulationExecutionGuard上限超過を表す。入力起因の
 * `DomainValidationError`（`INVALID_COMMAND`へ変換）とは別種のため独立したクラスに
 * する — レビュー指摘[P1]。呼び出し側（UseCase）がこの型で捕捉し
 * `EXECUTION_LIMIT_EXCEEDED`（HTTP 503）へ変換する。
 */
export class ExecutionGuardExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionGuardExceededError";
  }
}
