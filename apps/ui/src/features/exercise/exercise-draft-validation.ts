// Mirrors docs/ui-design/03_API・データ連携設計.md §2.3 and 01_UI要求・画面設計.md
// §5 (UI-AC-019/020): 戦術演習は敵ちょうど1体・敵メモリー0件・ターン上限5固定。
import { EXERCISE_ENEMY_CATEGORY, PLAYABLE_CATEGORY } from "../catalog-selection/unit-pool.js";
import { validateDraftWithRules } from "../formation/draft-validation.js";
import type { BattleDraft, ExerciseExecutionInput } from "../../entities/battle-draft.js";
import type { UiViolation } from "../../entities/violation.js";
import type { BattleSimulationCatalogResponse } from "../../shared/api/api-contract.js";
import type { DraftValidationRules } from "../formation/draft-validation.js";
import { MAX_EXERCISE_RUN_COUNT, MIN_EXERCISE_RUN_COUNT } from "../formation/types.js";

const EXERCISE_RULES: DraftValidationRules = {
  enemyUnitCount: { min: 1, max: 1, message: "戦術演習では敵ユニットを1体だけ設定してください。" },
  enemyMemoryCount: { max: 0, message: "戦術演習では敵メモリーを設定できません。" },
  validatesTurnLimit: false,
  // R-TEX-11 #2: 味方はプレイアブル、敵は演習専用ユニットだけを受理する。
  unitPools: { ally: PLAYABLE_CATEGORY, enemy: EXERCISE_ENEMY_CATEGORY },
};

/**
 * 実行回数の入力欄が拾う違反のpath。評価APIに対応する項目は無い（実行回数はチャンクの
 * `runIndices`へ展開される）ため画面側で決め、サーバーの試行計画への違反もここへ寄せる
 * （`evaluation-violation-mapper.ts`）。
 */
export const RUN_COUNT_VIOLATION_PATH = "/runCount";

/**
 * 実行回数は統計実行のときだけ送信へ効く。単一実行でも検証すると、統計実行を一度も
 * 選んでいない利用者が入力途中の値で実行できなくなる。
 */
function validateExerciseExecution(execution: ExerciseExecutionInput): readonly UiViolation[] {
  if (execution.mode !== "STATISTICS") {
    return [];
  }
  const { runCount } = execution;
  const isValid =
    runCount !== "" &&
    Number.isInteger(runCount) &&
    runCount >= MIN_EXERCISE_RUN_COUNT &&
    runCount <= MAX_EXERCISE_RUN_COUNT;
  if (isValid) {
    return [];
  }
  return [
    {
      path: RUN_COUNT_VIOLATION_PATH,
      code: "RUN_COUNT_OUT_OF_RANGE",
      message: `実行回数は${MIN_EXERCISE_RUN_COUNT}～${MAX_EXERCISE_RUN_COUNT.toLocaleString("en-US")}の整数で入力してください。`,
      severity: "error",
    },
  ];
}

export function validateExerciseDraft(
  draft: BattleDraft,
  catalog: BattleSimulationCatalogResponse,
): readonly UiViolation[] {
  return [
    ...validateDraftWithRules(draft, catalog, EXERCISE_RULES),
    ...validateExerciseExecution(draft.exerciseExecution),
  ];
}
