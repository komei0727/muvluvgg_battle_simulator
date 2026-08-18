// レベルリンクの解決（docs/ui-design/01_UI要求・画面設計.md §5.6・§5.7、
// docs/ui-design/03_API・データ連携設計.md §3.1）。
//
// リンクの反映は**参照時解決**とする。真実の値はリンクレベル1つだけで、各枠の
// `level`は保持したままリンク中は読まない。リンクレベルを各枠へ書き写すと値の
// 置き場が二重化し、書き写しの取りこぼしでズレる。
//
// 解決点をこのファイル1つに閉じ、リクエスト生成・送信前検証・表示が同じ規則を
// 共有する。同じ規則を`tools/exercise-lab`の`resolved_level`（`player_data.py`）が
// 写しており、片方だけ変えるとUIとlabが別のレベルで同じ編成を評価する。

import { DEFAULT_UNIT_LEVEL } from "./types.js";
import type { FormationSlotInput, SideEnhancementInput, UnitEnhancementInput } from "./types.js";

function isPositiveInteger(value: number | ""): value is number {
  return value !== "" && Number.isInteger(value) && value >= 1;
}

/**
 * その強化入力がリンクの適用を受けているか。
 *
 * 判定はリンクレベルの妥当性を**見ない**。見ると、リンクレベルを打ち直すために
 * 消した瞬間に各枠の入力途中の`""`が一斉に`UNIT_LEVEL_INVALID`として現れ、免除の
 * 目的（詰み状態を作らない）が崩れる（03_API・データ連携設計.md §6）。
 *
 * 強化入力を一度も開いていない枠（`undefined`）もリンク対象とする（`UI-API-024`）。
 * 外すと「ユニットを置いただけの枠は200のまま」となり、枠ごとに開く手間を消すという
 * 目的そのものを満たさない。
 */
export function isLevelLinked(
  enhancement: UnitEnhancementInput | undefined,
  sideEnhancement: SideEnhancementInput,
): boolean {
  return (
    sideEnhancement.enabled &&
    sideEnhancement.levelLink.enabled &&
    enhancement?.linkExcluded !== true
  );
}

export function isSlotLevelLinked(
  slot: FormationSlotInput,
  sideEnhancement: SideEnhancementInput,
): boolean {
  return isLevelLinked(slot.enhancement, sideEnhancement);
}

/**
 * その枠へ実際に適用されるレベル。
 *
 * リンクレベルが1以上の整数でない間（打ち直しのために消した`""`を含む）はリンクを
 * 適用せず枠の値へフォールバックする。この状態では`LEVEL_LINK_INVALID`で送信自体が
 * 止まるため、解決結果はステータスプレビューの表示にしか使われない。フォールバック
 * しないと、リンク入力を消した瞬間に陣営の全枠が`level: ""`のプレビューPOSTを起こす。
 */
export function resolveSlotLevel(
  slot: FormationSlotInput,
  sideEnhancement: SideEnhancementInput,
): number | "" {
  const { levelLink } = sideEnhancement;
  if (isSlotLevelLinked(slot, sideEnhancement) && isPositiveInteger(levelLink.level)) {
    return levelLink.level;
  }
  return slot.enhancement?.level ?? DEFAULT_UNIT_LEVEL;
}
