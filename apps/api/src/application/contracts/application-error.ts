/**
 * `09_アプリケーション設計.md` の エラー分類. `SimulateBattleUseCase` から
 * Inbound Adapterへ返る唯一の失敗形。ドメインモデルへAPI向けメッセージや
 * HTTPステータスを持たせない。
 *
 * `#16`時点でUseCaseが実際に送出するのは `INVALID_COMMAND`、
 * `DEFINITION_NOT_FOUND`、`UNSUPPORTED_RULE`。`#18`で協調的な期限確認
 * （`SimulateBattleUseCase`のターン境界チェック）が`EXECUTION_TIMEOUT`を、
 * `SimulationWorkerPool`のキャンセル処理が`EXECUTION_CANCELLED`を送出する
 * ようになった。`EXECUTION_LIMIT_EXCEEDED`と`DOMAIN_RULE_VIOLATION`は
 * イベント数・PS深度などの実行保護（M6以降）と将来のドメイン不変条件違反
 * 向けに、分類だけを先に確定しておく。
 */
export const APPLICATION_ERROR_CODES = [
  "INVALID_COMMAND",
  "DEFINITION_NOT_FOUND",
  "UNSUPPORTED_RULE",
  "INVALID_DEFINITION",
  "DOMAIN_RULE_VIOLATION",
  "EXECUTION_LIMIT_EXCEEDED",
  "EXECUTION_TIMEOUT",
  "EXECUTION_CANCELLED",
  "INTERNAL_INVARIANT_VIOLATION",
] as const;
export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number];

export interface Violation {
  readonly path?: string;
  readonly definitionId?: string;
  readonly ruleId?: string;
  readonly reason: string;
}

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly violations: readonly Violation[];
  readonly diagnosticId?: string;

  constructor(code: ApplicationErrorCode, violations: readonly Violation[], diagnosticId?: string) {
    super(`${code}: ${violations.map((v) => v.reason).join("; ")}`);
    this.name = "ApplicationError";
    this.code = code;
    this.violations = violations;
    if (diagnosticId !== undefined) {
      this.diagnosticId = diagnosticId;
    }
  }
}
