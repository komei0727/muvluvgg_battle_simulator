import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import { attributeAdvantageOf } from "../model/attribute-advantage.js";
import type { Percentage } from "../../shared/percentage.js";

export { isFavorableAttribute } from "../model/attribute-advantage.js";

/**
 * R-ATR-02: 有利属性なら`100% + 属性相性ボーナス`、そうでなければ100%。
 * ボーナスは有利属性の場合だけ加算する。
 *
 * 基準が125%ではなく100%なのは、`affinityBonus`が既定値25%（Q-CAT-05）を含んだ
 * ユニットステータスだからである（R-ENH-06のギア加算・R-STA-01の戦闘中補正もこの値へ
 * パーセントポイントで足し込む）。R-ATR-02が挙げる「125%」は既定値込みの結果であり、
 * ここで別途125%を足すと既定値が二重に乗る。
 *
 * R-ATR-03: 攻撃側のメイン属性が有利にならない場合だけ、攻撃側のサブ属性
 * （サブ属性付きユニットのみ）で同じ有利判定を再チェックする。有利ならメインより
 * 低い`subAffinityBonus`（既定15%）を加算する。メインが有利な場合はサブ属性を
 * 無視する（二重加算しない）。
 */
export function resolveAttributeMultiplier(
  attacker: Attribute,
  defender: Attribute,
  affinityBonus: Percentage,
  subAttacker: Attribute | undefined,
  subAffinityBonus: Percentage,
): number {
  const advantage = attributeAdvantageOf(
    { attribute: attacker, ...(subAttacker === undefined ? {} : { subAttribute: subAttacker }) },
    defender,
  );
  if (advantage === "MAIN") {
    return 1 + affinityBonus;
  }
  if (advantage === "SUB") {
    return 1 + subAffinityBonus;
  }
  return 1;
}
