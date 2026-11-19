import type { BattleUnit } from "../model/battle-unit.js";
import type { Side } from "../../shared/side.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * PSの契機イベントが属するスキル使用について、記録済みイベントから読み出す事実。
 * 記録の走査を要するため、条件や対象解決が実際に参照するときだけ呼ぶ。
 */
export interface TriggerSkillUseRecord {
  /** 1ヒット以上命中させた対象（全ヒット回避だけが含まれない、`hitCondition`と同じ単位）。 */
  hitUnitIds(): ReadonlySet<BattleUnitId>;
  /**
   * 実際にEffectActionを処理した対象を、処理した順（＝対象優先度順）に重複なく並べたもの。
   * 実行されなかった分岐の候補は含まない。契機がスキル使用に属さなければ`undefined`。
   */
  processedTargetUnitIds(): readonly BattleUnitId[] | undefined;
}

/**
 * `TRIGGER_PRIMARY_TARGET`: 元スキルが実際に処理した対象（対象優先度順）のうち、
 * `ownerSide`から見た敵の先頭1体。元スキルが自身や味方を
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
