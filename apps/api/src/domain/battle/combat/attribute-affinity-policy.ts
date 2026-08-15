import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import type { Percentage } from "../../shared/percentage.js";

/**
 * R-ATR-01: 攻撃側属性ごとの有利な防御側属性。Catalogにはデータ化されておらず
 * (`07_戦闘ルール詳細.md`のprose定義のみ)、固定テーブルとして扱う。
 */
const FAVORABLE_DEFENDER: Readonly<Record<Attribute, Attribute>> = {
  AGGRESSIVE: "SHY",
  SHY: "CUTE",
  CUTE: "SMART",
  SMART: "AGGRESSIVE",
  COMICAL: "CLEVER",
  CLEVER: "COMICAL",
};

/** R-ATR-01: 攻撃側属性が防御側属性に対して有利かどうか。 */
export function isFavorableAttribute(attacker: Attribute, defender: Attribute): boolean {
  return FAVORABLE_DEFENDER[attacker] === defender;
}

/**
 * R-ATR-02: 有利属性なら`100% + 属性相性ボーナス`、そうでなければ100%。
 * ボーナスは有利属性の場合だけ加算する。
 *
 * 基準が125%ではなく100%なのは、`affinityBonus`が既定値25%（Q-CAT-05）を含んだ
 * ユニットステータスだからである（R-ENH-06のギア加算・R-STA-01の戦闘中補正もこの値へ
 * パーセントポイントで足し込む）。R-ATR-02が挙げる「125%」は既定値込みの結果であり、
 * ここで別途125%を足すと既定値が二重に乗る。
 */
export function resolveAttributeMultiplier(
  attacker: Attribute,
  defender: Attribute,
  affinityBonus: Percentage,
): number {
  if (!isFavorableAttribute(attacker, defender)) {
    return 1;
  }
  return 1 + affinityBonus;
}
