// Mirrors docs/ui-design/03_API・データ連携設計.md §2.3 and docs/ddd/10_API設計.md
// 「TacticalExerciseRequest」: 編成部分は戦闘シミュレーションと同じ`FormationRequest`
// を再利用し、`turnLimit`を持たない。

import { buildFormation } from "../formation/request-mapper.js";
import type { FormationRequest, RequestBuildResult } from "../formation/request-mapper.js";
import { enhancementForSide } from "../formation/types.js";
import type { BattleDraft, LogLevel, SideEnhancementInput } from "../formation/types.js";

export interface TacticalExerciseRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly options: { readonly logLevel: LogLevel };
}

const EXERCISE_ENEMY_UNIT_COUNT = 1;

/**
 * UI-AC-041: 単一実行は「ログを読むための1回」であり、演習の画面からログレベルの
 * 選択そのものが無くなった（Issue #539）。`SUMMARY`を選ぶ動機だった「大量実行して
 * 集計を見る」は統計実行が担うため、draftに残っている値に依らず`DETAILED`で送る。
 */
const SINGLE_RUN_LOG_LEVEL: LogLevel = "DETAILED";

/**
 * UI-AC-020: 演習の敵は強化を持たない（`R-TEX-01` #1）。画面が敵強化の入力を
 * 出さないことに依存せず、リクエスト生成側でも強化無効として組み立てる。
 * `enabled: false` は陣営単位の`enhancement`とユニット単位の`enhancement`の
 * 両方を出力対象から外す（`request-mapper.ts` の`buildFormation`）。
 */
function disabledEnhancement(enhancement: SideEnhancementInput): SideEnhancementInput {
  return { ...enhancement, enabled: false };
}

/**
 * UI-API-014: `turnLimit`を出力せず、敵ちょうど1体・敵メモリー0件を送信前に強制する。
 * 演習モードの画面は敵枠を1つしか出さないが、リクエスト生成側でも制約を満たさない
 * draftを組み立てないことで、画面の作りに依存せず契約違反の送信を防ぐ。
 */
export function buildTacticalExerciseRequest(
  draft: BattleDraft,
): RequestBuildResult<TacticalExerciseRequest> {
  const ally = buildFormation(
    "ally",
    draft.allySlots,
    draft.allyMemoryDefinitionIds,
    enhancementForSide(draft, "ally"),
  );
  const enemy = buildFormation(
    "enemy",
    draft.enemySlots,
    draft.enemyMemoryDefinitionIds,
    disabledEnhancement(enhancementForSide(draft, "enemy")),
  );
  if (ally === undefined || enemy === undefined) {
    return { ok: false };
  }
  if (enemy.formation.units.length !== EXERCISE_ENEMY_UNIT_COUNT) {
    return { ok: false };
  }
  if (enemy.formation.memoryDefinitionIds.length > 0) {
    return { ok: false };
  }

  return {
    ok: true,
    request: {
      allyFormation: ally.formation,
      enemyFormation: enemy.formation,
      options: { logLevel: SINGLE_RUN_LOG_LEVEL },
    },
    allyUnitSlotKeys: ally.unitSlotKeys,
    enemyUnitSlotKeys: enemy.unitSlotKeys,
    allyMemorySlotKeys: ally.memorySlotKeys,
    enemyMemorySlotKeys: enemy.memorySlotKeys,
    allyGearSlotIndices: ally.gearSlotIndices,
    enemyGearSlotIndices: enemy.gearSlotIndices,
  };
}
