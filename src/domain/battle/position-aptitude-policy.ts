import type { ModifierStat } from "../catalog/memory-definition.js";
import type { PositionRow } from "../catalog/catalog-enums.js";
import { createPercentage, type Percentage } from "./percentage.js";

/** R-STA-01: 適正外配置によるHP、攻撃力、防御力の適性補正。 */
const APTITUDE_PENALTY = createPercentage(0.05);
const NO_PENALTY = createPercentage(0);

/** R-STA-01: 適正外配置の影響を受けるステータス。それ以外は常に適性補正0とする。 */
const APTITUDE_AFFECTED_STATS: ReadonlySet<ModifierStat> = new Set([
  "MAXIMUM_HP",
  "ATTACK",
  "DEFENSE",
]);

/** R-STA-01: 配置行がpositionAptitudesに含まれない場合だけ適性補正を課す。 */
export function resolveAptitudePenalty(
  positionAptitudes: readonly PositionRow[],
  row: PositionRow,
  stat: ModifierStat,
): Percentage {
  if (!APTITUDE_AFFECTED_STATS.has(stat)) {
    return NO_PENALTY;
  }
  return positionAptitudes.includes(row) ? NO_PENALTY : APTITUDE_PENALTY;
}
