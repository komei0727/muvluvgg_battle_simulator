import type { BattleUnit } from "../model/battle-unit.js";

const SIDE_ORDER: Record<BattleUnit["side"], number> = { ALLY: 0, ENEMY: 1 };
const ROW_ORDER: Record<BattleUnit["position"]["row"], number> = { FRONT: 0, BACK: 1 };

/**
 * `ActionOrderPolicy` (`05_ドメインモデル.md`). R-ORD-02: 行動速度desc→陣営
 * （味方、敵）→行（前列、後列）→列（絶対左、中央、右）の順に比較キーを適用する。
 * 各キーは配置により一意になるため、入力配列の順序には依存しない。
 */
export function compareActionOrder(a: BattleUnit, b: BattleUnit): number {
  if (a.combatStats.actionSpeed !== b.combatStats.actionSpeed) {
    return b.combatStats.actionSpeed - a.combatStats.actionSpeed;
  }
  if (SIDE_ORDER[a.side] !== SIDE_ORDER[b.side]) {
    return SIDE_ORDER[a.side] - SIDE_ORDER[b.side];
  }
  if (ROW_ORDER[a.position.row] !== ROW_ORDER[b.position.row]) {
    return ROW_ORDER[a.position.row] - ROW_ORDER[b.position.row];
  }
  return a.globalCoordinate.x - b.globalCoordinate.x;
}

/** R-ORD-02を適用した新しい配列を返す。入力配列は変更しない。 */
export function sortByActionOrder(units: readonly BattleUnit[]): readonly BattleUnit[] {
  return [...units].sort(compareActionOrder);
}
