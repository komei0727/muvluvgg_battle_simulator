import type { BattleUnit } from "../model/battle-unit.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `TRIGGER_PRIMARY_TARGET`: 契機イベントの対象（元スキルの対象を対象優先度順に
 * 並べたもの）のうち、`ownerSide`から見た敵の先頭1体。元スキルが自身や味方を
 * 先に対象へ含んでいても、追撃が向かうのは元の攻撃対象の先頭である。戦闘不能かどうかは
 * 問わない — 先頭が倒れていることを、後続の敵への繰り上げではなく不在として扱うため。
 */
export function triggerPrimaryTargetId(
  triggerTargetUnitIds: readonly BattleUnitId[] | undefined,
  ownerSide: Side,
  findUnit: (battleUnitId: BattleUnitId) => BattleUnit | undefined,
): BattleUnitId | undefined {
  return (triggerTargetUnitIds ?? []).find((id) => {
    const unit = findUnit(id);
    return unit !== undefined && unit.side !== ownerSide;
  });
}
