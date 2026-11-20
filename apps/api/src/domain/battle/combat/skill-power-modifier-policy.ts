import type { BattleUnit } from "../model/battle-unit.js";

/**
 * R-DMG-08: 攻撃側が保持する`APPLY_SKILL_POWER_MOD`（`isSkillPowerModifier`）の
 * スキル威力倍率を求める。R-DMG-04の与ダメージ補正のような符号付き割合の加算ではなく、
 * インスタンスごとの`max(0, 1 + magnitude)`を乗算する（-75%を2つ持てば×0.0625）。
 * 因子ごとに0で止めるのは、-100%を超える低下が2つ重なったときに積が正へ戻らないためである。
 * stackingは`STACKABLE`のみなので、保持している全インスタンスが常に有効。
 */
export function composeSkillPowerMultiplier(attacker: BattleUnit): number {
  return attacker.appliedEffects.reduce(
    (product, effect) =>
      effect.isSkillPowerModifier === true ? product * Math.max(0, 1 + effect.magnitude) : product,
    1,
  );
}
