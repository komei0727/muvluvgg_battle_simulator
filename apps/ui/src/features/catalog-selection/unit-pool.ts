// Mirrors docs/ddd/07_戦闘ルール詳細.md `R-TEX-11` and
// docs/ui-design/01_UI要求・画面設計.md §5.2 (UI-AC-033).
import type { Side } from "../../entities/battle-draft.js";
import type { BattleMode } from "../../entities/battle-mode.js";
import type { CatalogUnitSummary } from "../../shared/api/api-contract.js";

export const PLAYABLE_CATEGORY = "PLAYABLE";
export const EXERCISE_ENEMY_CATEGORY = "EXERCISE_ENEMY";

/**
 * R-TEX-11 #1: 定義書で省略された場合も`PLAYABLE`とする。`category`を返さない
 * 旧APIの応答（`api-contract.ts`が任意項目にしている理由）もここで吸収する。
 */
export function unitCategoryOf(unit: CatalogUnitSummary): string {
  return unit.category ?? PLAYABLE_CATEGORY;
}

export function isExerciseEnemyUnit(unit: CatalogUnitSummary): boolean {
  return unitCategoryOf(unit) === EXERCISE_ENEMY_CATEGORY;
}

/** R-TEX-11 #2 #3: モードと陣営の組から、その枠が受け入れるカテゴリを決める。 */
export function unitPoolCategoryFor(mode: BattleMode, side: Side): string {
  return mode === "exercise" && side === "enemy" ? EXERCISE_ENEMY_CATEGORY : PLAYABLE_CATEGORY;
}

/**
 * 選択ダイアログへ出す候補を編成プールで絞る。開催終了（`exerciseActive: false`）の
 * 演習ユニットも候補に残す — 受理条件ではなく表示専用の情報であるため（R-TEX-11 #4）。
 */
export function selectUnitPool(
  units: readonly CatalogUnitSummary[],
  mode: BattleMode,
  side: Side,
): readonly CatalogUnitSummary[] {
  const allowed = unitPoolCategoryFor(mode, side);
  return units.filter((unit) => unitCategoryOf(unit) === allowed);
}
