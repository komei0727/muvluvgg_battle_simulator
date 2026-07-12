import type { Attribute } from "../catalog/catalog-enums.js";
import type { Percentage } from "./percentage.js";

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
 * R-ATR-02: 有利属性なら`125% + 属性相性ボーナス`、そうでなければ100%。
 * ボーナスは有利属性の場合だけ加算する。
 */
export function resolveAttributeMultiplier(
  attacker: Attribute,
  defender: Attribute,
  affinityBonus: Percentage,
): number {
  if (!isFavorableAttribute(attacker, defender)) {
    return 1;
  }
  return 1.25 + affinityBonus;
}
