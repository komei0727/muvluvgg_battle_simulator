// 一括評価の422 violationを、送信時のslot対応表へ結びつける。
//
// 評価APIは候補indexを含むpath（`/candidates/0/allyFormation/...`）で返す
// （`10_API設計.md`「候補の編成違反は candidates[i].allyFormation... として返す」）。
// 共有の敵編成と`runsPerCandidate`は候補indexを持たない。統計実行は候補を常に1件しか
// 送らないため、`/candidates/0`を落とせば単一実行とまったく同じ対応づけになる
// （`violation-mapper.ts`。UI-API-004）。

import type { StatisticsRunSubmission } from "./use-exercise-statistics-run.js";
import type { UiViolation } from "../formation/draft-validation.js";
import type { ViolationResponseBody } from "../../shared/api/api-contract.js";
import { mapServerViolationsToUiViolations } from "../simulation/violation-mapper.js";

/** 送信した唯一の候補。これ以外のindexが来たら対応づけない（枠を取り違えるより無印にする）。 */
const SUBMITTED_CANDIDATE_PREFIX = "/candidates/0";

function withoutCandidatePrefix(path: string): string {
  return path.startsWith(`${SUBMITTED_CANDIDATE_PREFIX}/`)
    ? path.slice(SUBMITTED_CANDIDATE_PREFIX.length)
    : path;
}

export function mapEvaluationViolationsToUiViolations(
  violations: readonly ViolationResponseBody[],
  submission: StatisticsRunSubmission,
): readonly UiViolation[] {
  const mapped = mapServerViolationsToUiViolations(
    violations.map((violation) =>
      violation.path === undefined
        ? violation
        : { ...violation, path: withoutCandidatePrefix(violation.path) },
    ),
    submission.allyUnitSlotKeys,
    submission.enemyUnitSlotKeys,
    submission.allyMemorySlotKeys,
    submission.enemyMemorySlotKeys,
    { ally: submission.allyGearSlotIndices, enemy: submission.enemyGearSlotIndices },
  );

  // 表示するpathはサーバーが返したものへ戻す。候補indexを落とした形を出すと、
  // サーバーのログやAPIドキュメントと突き合わせられなくなる。
  return mapped.map((violation, index) => {
    const original = violations[index]?.path;
    return original === undefined ? violation : { ...violation, path: original };
  });
}
