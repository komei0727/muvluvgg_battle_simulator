// Mirrors docs/ui-design/03_API・データ連携設計.md §2.3 and docs/ddd/10_API設計.md
// 「TacticalExerciseRequest」: 編成部分は戦闘シミュレーションと同じ`FormationRequest`
// を再利用し、`turnLimit`を持たない。

import { buildFormation } from "../formation/request-mapper.js";
import type { FormationRequest, RequestBuildResult } from "../formation/request-mapper.js";
import { enhancementForSide } from "../formation/types.js";
import type { BattleDraft, LogLevel } from "../formation/types.js";

export interface TacticalExerciseRequest {
  readonly allyFormation: FormationRequest;
  readonly enemyFormation: FormationRequest;
  readonly options: { readonly logLevel: LogLevel };
}

const EXERCISE_ENEMY_UNIT_COUNT = 1;

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
    enhancementForSide(draft, "enemy"),
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
      options: { logLevel: draft.logLevel },
    },
    allyUnitSlotKeys: ally.unitSlotKeys,
    enemyUnitSlotKeys: enemy.unitSlotKeys,
    allyMemorySlotKeys: ally.memorySlotKeys,
    enemyMemorySlotKeys: enemy.memorySlotKeys,
    allyGearSlotIndices: ally.gearSlotIndices,
    enemyGearSlotIndices: enemy.gearSlotIndices,
  };
}
