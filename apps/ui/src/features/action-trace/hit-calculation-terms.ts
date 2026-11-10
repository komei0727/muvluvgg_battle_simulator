// docs/ui-design/03_API・データ連携設計.md §12.1.1（§12.5「ヒットの内訳」が参照）。
//
// 処理の一覧のヒットの行に出す`DAMAGE_CALCULATED`の計算項目。並びはR-DMG-01の乗算順
// （時系列イベントの要約と同じ）。計算を疑うときに一番確かめたい「威力1」「貫通0%」
// 「ダメージ無効なし」が消えないよう、0・1倍・falseでも出し、落とすのはpayloadがその項目
// 自体を持たないときだけとする。値は投影が読んだものをそのまま整形し、再計算しない。
import type { HitCalculation } from "./trace-step-projector.js";

export interface HitCalculationTerm {
  readonly label: string;
  readonly value: string;
}

const NUMBER_FORMAT = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 4 });

function numberText(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function percentText(rate: number): string {
  return `${Number((rate * 100).toPrecision(12)).toString()}%`;
}

type NumericKey = {
  readonly [K in keyof HitCalculation]-?: HitCalculation[K] extends number | undefined ? K : never;
}[keyof HitCalculation];

function amount(
  calculation: HitCalculation,
  key: NumericKey,
  label: string,
): HitCalculationTerm | undefined {
  const value = calculation[key];
  return value !== undefined ? { label, value: numberText(value) } : undefined;
}

function rate(
  calculation: HitCalculation,
  key: NumericKey,
  label: string,
): HitCalculationTerm | undefined {
  const value = calculation[key];
  return value !== undefined ? { label, value: percentText(value) } : undefined;
}

function text(label: string, value: string | undefined): HitCalculationTerm | undefined {
  return value !== undefined ? { label, value } : undefined;
}

function flag(
  label: string,
  value: boolean | undefined,
  words: readonly [string, string],
): HitCalculationTerm | undefined {
  return value !== undefined ? { label, value: value ? words[0] : words[1] } : undefined;
}

/**
 * 属性倍率1が「有利でない」のか「有利だが有利属性ダメージ0%」なのかを`isFavorableAttribute`
 * で語に分ける。R-SUB-02の追加ヒットは属性相性の欄を持たないため、その場合は出さない。
 */
function matchupTerm(calculation: HitCalculation): HitCalculationTerm | undefined {
  const favorable = calculation.isFavorableAttribute;
  if (favorable === undefined) {
    return undefined;
  }
  const { attackerAttribute, defenderAttribute } = calculation;
  const matchup =
    attackerAttribute !== undefined && defenderAttribute !== undefined
      ? ` ${attackerAttribute}→${defenderAttribute}`
      : "";
  return { label: "属性相性", value: `${favorable ? "有利" : "有利なし"}${matchup}` };
}

export function hitCalculationTerms(calculation: HitCalculation): readonly HitCalculationTerm[] {
  return [
    text("種別", calculation.damageType),
    amount(calculation, "attackerAttack", "攻撃力"),
    amount(calculation, "defenderDefense", "防御力"),
    amount(calculation, "effectiveDefense", "実効防御"),
    rate(calculation, "defenseIgnoreRate", "防御貫通"),
    rate(calculation, "shieldIgnoreRate", "シールド貫通"),
    rate(calculation, "damageReductionIgnoreRate", "軽減貫通"),
    amount(calculation, "baseDamage", "基礎ダメージ"),
    amount(calculation, "skillPower", "スキル威力"),
    text("Formula", calculation.skillPowerFormulaKind),
    amount(calculation, "attributeMultiplier", "属性倍率"),
    matchupTerm(calculation),
    rate(calculation, "attackerAffinityBonus", "有利属性ダメージ"),
    flag("サブ属性有利", calculation.isSubAttributeFavorable, ["あり", "なし"]),
    amount(calculation, "criticalMultiplier", "会心倍率"),
    amount(calculation, "outgoingDamageMultiplier", "与ダメージ倍率"),
    amount(calculation, "incomingDamageMultiplier", "被ダメージ倍率"),
    amount(calculation, "actionDamageMultiplier", "Action内追加倍率"),
    amount(calculation, "confusionDamageMultiplier", "混乱倍率"),
    amount(calculation, "rawPreTruncationDamage", "倍率適用後"),
    amount(calculation, "freezeMultiplier", "凍結増幅"),
    rate(calculation, "guardRate", "肩代わり軽減"),
    amount(calculation, "preTruncationDamage", "切り捨て前"),
    amount(calculation, "thresholdReductionMultiplier", "閾値軽減倍率"),
    flag("ダメージ無効", calculation.damageImmunityNullified, ["あり", "なし"]),
    amount(calculation, "finalDamage", "計算ダメージ"),
  ].filter((term): term is HitCalculationTerm => term !== undefined);
}
