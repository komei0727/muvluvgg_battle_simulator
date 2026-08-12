// Mirrors docs/ui-design/03_API・データ連携設計.md §2.3 and 01_UI要求・画面設計.md
// §5 (UI-AC-019/020): 戦術演習は敵ちょうど1体・敵メモリー0件・ターン上限5固定。

import { validateDraftWithRules } from "../formation/draft-validation.js";
import type { DraftValidationRules, UiViolation } from "../formation/draft-validation.js";
import type { BattleDraft } from "../formation/types.js";
import type { BattleSimulationCatalogResponse } from "../simulation/api-contract.js";

/** R-TEX-01: 演習のターン数は固定で、リクエストにも入力にも現れない。 */
export const EXERCISE_TURN_LIMIT = 5;

const EXERCISE_RULES: DraftValidationRules = {
  enemyUnitCount: { min: 1, max: 1, message: "戦術演習では敵ユニットを1体だけ設定してください。" },
  enemyMemoryCount: { max: 0, message: "戦術演習では敵メモリーを設定できません。" },
  validatesTurnLimit: false,
};

export function validateExerciseDraft(
  draft: BattleDraft,
  catalog: BattleSimulationCatalogResponse,
): readonly UiViolation[] {
  return validateDraftWithRules(draft, catalog, EXERCISE_RULES);
}
