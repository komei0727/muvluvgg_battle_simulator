import type { Violation } from "../contracts/application-error.js";

/**
 * 大量試行の結果を再現できる条件のうち、戦闘実装を識別する情報。起動時に一度だけ確定させて
 * 注入する — リクエストごとに外部コマンドを実行しないためと、同じプロセスが返す値を
 * 試行の途中で変えないためである。
 */
export interface EvaluationRuntimeInfo {
  readonly engineRevision: string;
}

export interface ExpectedRevisions {
  readonly expectedCatalogRevision?: string;
  readonly expectedEngineRevision?: string;
}

export interface ActualRevisions {
  readonly catalogRevision: string;
  readonly engineRevision: string;
}

/**
 * 期待値を指定したリクエストだけ、実行前に実際の識別情報と照合する。不一致は戦闘を
 * 1回も開始せず`INVALID_COMMAND`として返す — 別の実装・Catalogで得た結果を、指定した
 * 条件で得たものとして混ぜないためである。
 */
export function validateExpectedRevisions(
  expected: ExpectedRevisions,
  actual: ActualRevisions,
): Violation[] {
  const violations: Violation[] = [];
  if (
    expected.expectedCatalogRevision !== undefined &&
    expected.expectedCatalogRevision !== actual.catalogRevision
  ) {
    violations.push({
      path: "expectedCatalogRevision",
      reason: `does not match the server catalogRevision "${actual.catalogRevision}", got "${expected.expectedCatalogRevision}"`,
    });
  }
  if (
    expected.expectedEngineRevision !== undefined &&
    expected.expectedEngineRevision !== actual.engineRevision
  ) {
    violations.push({
      path: "expectedEngineRevision",
      reason: `does not match the server engineRevision "${actual.engineRevision}", got "${expected.expectedEngineRevision}"`,
    });
  }
  return violations;
}
