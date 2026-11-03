import type { Attribute } from "../../catalog/definitions/catalog-enums.js";

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

export interface AttributeHolder {
  readonly attribute: Attribute;
  readonly subAttribute?: Attribute;
}

/**
 * R-ATR-03/05: 攻撃側が防御側（メイン属性だけで判定する）に対してどちらの属性で
 * 有利かを返す。メイン属性が有利でない場合だけサブ属性で再判定する。属性倍率
 * （`attribute-affinity-policy.ts`）と条件（`ATTRIBUTE_ADVANTAGE`）の両方が
 * この1つの判定を使い、倍率と条件の結果が食い違わないようにする。
 */
export function attributeAdvantageOf(
  attacker: AttributeHolder,
  defender: Attribute,
): "MAIN" | "SUB" | null {
  if (isFavorableAttribute(attacker.attribute, defender)) {
    return "MAIN";
  }
  if (
    attacker.subAttribute !== undefined &&
    isFavorableAttribute(attacker.subAttribute, defender)
  ) {
    return "SUB";
  }
  return null;
}

export function hasAttributeAdvantage(attacker: AttributeHolder, defender: Attribute): boolean {
  return attributeAdvantageOf(attacker, defender) !== null;
}
