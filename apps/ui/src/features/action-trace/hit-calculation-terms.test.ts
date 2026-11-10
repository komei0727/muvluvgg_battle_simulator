import { describe, expect, it } from "vitest";
import { hitCalculationTerms } from "./hit-calculation-terms.js";

function texts(terms: ReturnType<typeof hitCalculationTerms>): readonly string[] {
  return terms.map((term) => `${term.label}${term.value}`);
}

describe("hitCalculationTerms", () => {
  it("UI-UT-ATR-041: payloadにある計算項目を03 §12.1.1の並びで、0・1倍・falseも含めて全て出す", () => {
    expect(
      texts(
        hitCalculationTerms({
          damageType: "PHYSICAL",
          attackerAttack: 0,
          defenderDefense: 300,
          effectiveDefense: 200,
          defenseIgnoreRate: 0,
          shieldIgnoreRate: 0.25,
          damageReductionIgnoreRate: 0.1,
          baseDamage: 800,
          skillPower: 1,
          skillPowerFormulaKind: "SKILL_POWER",
          attributeMultiplier: 1.2,
          isFavorableAttribute: true,
          attackerAffinityBonus: 0.2,
          attackerAttribute: "CUTE",
          defenderAttribute: "COOL",
          isSubAttributeFavorable: false,
          criticalMultiplier: 1,
          outgoingDamageMultiplier: 1,
          incomingDamageMultiplier: 0.9,
          actionDamageMultiplier: 1,
          confusionDamageMultiplier: 1,
          rawPreTruncationDamage: 1036.8,
          freezeMultiplier: 1,
          guardRate: 0,
          preTruncationDamage: 1036.8,
          thresholdReductionMultiplier: 1,
          damageImmunityNullified: false,
          finalDamage: 1036,
        }),
      ),
    ).toEqual([
      "種別PHYSICAL",
      "攻撃力0",
      "防御力300",
      "実効防御200",
      "防御貫通0%",
      "シールド貫通25%",
      "軽減貫通10%",
      "基礎ダメージ800",
      "スキル威力1",
      "FormulaSKILL_POWER",
      "属性倍率1.2",
      "属性相性有利 CUTE→COOL",
      "有利属性ダメージ20%",
      "サブ属性有利なし",
      "会心倍率1",
      "与ダメージ倍率1",
      "被ダメージ倍率0.9",
      "Action内追加倍率1",
      "混乱倍率1",
      "倍率適用後1,036.8",
      "凍結増幅1",
      "肩代わり軽減0%",
      "切り捨て前1,036.8",
      "閾値軽減倍率1",
      "ダメージ無効なし",
      "計算ダメージ1,036",
    ]);
  });

  it("omits only the terms the payload does not carry, and words an unfavorable matchup and a nullified hit", () => {
    expect(
      texts(
        hitCalculationTerms({
          effectiveDefense: 0,
          isFavorableAttribute: false,
          damageImmunityNullified: true,
          finalDamage: 1,
        }),
      ),
    ).toEqual(["実効防御0", "属性相性有利なし", "ダメージ無効あり", "計算ダメージ1"]);
    expect(hitCalculationTerms({})).toEqual([]);
  });
});
