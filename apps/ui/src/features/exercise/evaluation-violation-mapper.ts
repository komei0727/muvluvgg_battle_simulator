// 大量試行の422 violationを、送信時のslot対応表へ結びつける。
//
// 評価APIはケースindexを含むpath（`/cases/0/allyFormation/...`）で返す
// （`10_API設計.md`「違反パスからケース・陣営・参加枠を特定できる」）。統計実行はケースを
// 常に1件しか送らないため、`/cases/0`を落とせば単一実行とまったく同じ対応づけになる
// （`violation-mapper.ts`。UI-API-004）。ケース数・試行数の違反は実行回数の入力欄へ寄せる。
import type { StatisticsRunSubmission } from "./use-exercise-statistics-run.js";
import { RUN_COUNT_VIOLATION_PATH } from "./exercise-draft-validation.js";
import type { UiViolation } from "../../entities/violation.js";
import type { ViolationResponseBody } from "../../shared/api/api-contract.js";
import { mapServerViolationsToUiViolations } from "../simulation/violation-mapper.js";

/** 送信した唯一のケース。これ以外のindexが来たら対応づけない（枠を取り違えるより無印にする）。 */
const SUBMITTED_CASE_PREFIX = "/cases/0";

function withoutCasePrefix(path: string): string {
  return path.startsWith(`${SUBMITTED_CASE_PREFIX}/`)
    ? path.slice(SUBMITTED_CASE_PREFIX.length)
    : path;
}

/** 試行の計画（件数・試行番号）への違反。画面で直せるのは実行回数だけである。 */
function isRunPlanPath(path: string): boolean {
  return path === "/cases" || path.startsWith(`${SUBMITTED_CASE_PREFIX}/runIndices`);
}

export function mapEvaluationViolationsToUiViolations(
  violations: readonly ViolationResponseBody[],
  submission: StatisticsRunSubmission,
): readonly UiViolation[] {
  const mapped = mapServerViolationsToUiViolations(
    violations.map((violation) =>
      violation.path === undefined
        ? violation
        : { ...violation, path: withoutCasePrefix(violation.path) },
    ),
    submission.allyUnitSlotKeys,
    submission.enemyUnitSlotKeys,
    submission.allyMemorySlotKeys,
    submission.enemyMemorySlotKeys,
    { ally: submission.allyGearSlotIndices, enemy: submission.enemyGearSlotIndices },
  );

  // 表示するpathはサーバーが返したものへ戻す。ケースindexを落とした形を出すと、
  // サーバーのログやAPIドキュメントと突き合わせられなくなる。試行の計画への違反だけは
  // 実行回数の入力欄が拾えるpathへ置き換える。
  return mapped.map((violation, index) => {
    const original = violations[index]?.path;
    if (original === undefined) {
      return violation;
    }
    return { ...violation, path: isRunPlanPath(original) ? RUN_COUNT_VIOLATION_PATH : original };
  });
}
