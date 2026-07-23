import { resolveAttributeMultiplier } from "./attribute-affinity-policy.js";
import { createPercentage } from "../../shared/percentage.js";
import type { Attribute } from "../../catalog/definitions/catalog-enums.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import { evaluateFormula, type FormulaEvaluationContext } from "../skill/formula-evaluator.js";

export interface DamageCalculationInput {
  readonly attackerAttack: number;
  readonly attackerAttribute: Attribute;
  readonly attackerAffinityBonus: number;
  readonly defenderDefense: number;
  readonly defenderAttribute: Attribute;
  /** R-DMG-01の実効防御力に使う。0なら通常処理、1なら防御力を全量無視する。 */
  readonly defenseIgnoreRate: number;
  /** R-DMG-01: スキル威力Formula（R-NUM-04のFormulaEvaluatorで評価する）。 */
  readonly skillPowerFormula: FormulaDefinition;
  /** R-DMG-01のAction内追加ダメージ倍率。各エントリを符号付き割合として評価し合計する。 */
  readonly damageModifiers: readonly FormulaDefinition[];
  /** `CriticalPolicy`が解決済みの会心倍率（R-CRT-02）。 */
  readonly criticalMultiplier: number;
  /** R-NUM-04: `skillPowerFormula`/`damageModifiers`を評価するための実行時文脈。 */
  readonly formulaContext: FormulaEvaluationContext;
}

/** `DamageCalculated`イベントでの監査に必要な計算過程を含む結果。 */
export interface DamageCalculationResult {
  /** R-DMG-01の実効防御力（`defenderDefense * (1 - defenseIgnoreRate)`）。 */
  readonly effectiveDefense: number;
  readonly skillPower: number;
  readonly attributeMultiplier: number;
  readonly actionDamageMultiplier: number;
  /** 最終切り捨て・最低1ダメージ（R-DMG-02）を適用する前の値。 */
  readonly preTruncationDamage: number;
  readonly finalDamage: number;
}

/**
 * R-DMG-01: 基礎ダメージ(攻撃力-防御力)へ乗算できるのは`SKILL_POWER`だけ
 * （レビュー指摘[P1]、PR #214）。それ以外のFormula種別（`CURRENT_HP_RATIO`
 * 等）はスキル威力の倍率ではなく、評価結果そのものが基礎ダメージとなる —
 * 攻撃力・防御力を経由しない。実Catalogの`ACT_FLUTE_VAMPIRE_AS1_HP_COST`
 * （対象の現在HP×0.25を直接ダメージ量とする定義）を攻撃側の攻撃力でさらに
 * 乗算してしまうと、意図した量から桁違いに拡大される。属性倍率・会心倍率・
 * Action内追加ダメージ倍率はFormula種別によらず通常どおり適用する
 * （`ACT_AOI_GUARDIAN_PS2_COUNTER`等はcritical/accuracy/piercingを上書きせず、
 * 通常の会心・命中判定を経る前提であるため）。
 */
function resolveBaseDamageAndSkillPower(
  formula: FormulaDefinition,
  attackerAttack: number,
  effectiveDefense: number,
  context: FormulaEvaluationContext,
): { readonly baseDamage: number; readonly skillPower: number } {
  if (formula.kind === "SKILL_POWER") {
    return {
      baseDamage: Math.max(0, attackerAttack - effectiveDefense),
      skillPower: formula.power,
    };
  }
  return {
    baseDamage: evaluateFormula(formula, context, "skillPowerFormula"),
    skillPower: 1,
  };
}

/**
 * R-DMG-01のAction内追加ダメージ倍率。R-DMG-04の与/被ダメージ倍率と同じ合成
 * パターン（符号付き割合の合計、倍率は`1 + 合計補正`、0未満は0とする）を適用する。
 */
function resolveActionDamageMultiplier(
  damageModifiers: readonly FormulaDefinition[],
  context: FormulaEvaluationContext,
): number {
  const sum = damageModifiers.reduce(
    (total, modifier, index) =>
      total + evaluateFormula(modifier, context, `damageModifiers[${index}]`),
    0,
  );
  return Math.max(0, 1 + sum);
}

/**
 * `DamageCalculator` (R-DMG-01, R-DMG-02の一部)。基礎値、スキル威力、属性倍率、
 * 会心倍率、Action内追加ダメージ倍率から計算ダメージを求め、最終切り捨てと
 * 最低1ダメージ（R-DMG-02の一部）を適用する。与ダメージ倍率・被ダメージ倍率
 * (R-DMG-04, AppliedEffectが必要)とダメージ無効効果(R-DMG-02の残り)は
 * M7未実装のため、この関数の対象外。
 */
export function calculateDamage(input: DamageCalculationInput): DamageCalculationResult {
  const effectiveDefense = input.defenderDefense * (1 - input.defenseIgnoreRate);
  const { baseDamage, skillPower } = resolveBaseDamageAndSkillPower(
    input.skillPowerFormula,
    input.attackerAttack,
    effectiveDefense,
    input.formulaContext,
  );
  const attributeMultiplier = resolveAttributeMultiplier(
    input.attackerAttribute,
    input.defenderAttribute,
    createPercentage(input.attackerAffinityBonus),
  );
  const actionDamageMultiplier = resolveActionDamageMultiplier(
    input.damageModifiers,
    input.formulaContext,
  );

  const preTruncationDamage =
    baseDamage *
    skillPower *
    attributeMultiplier *
    input.criticalMultiplier *
    actionDamageMultiplier;

  return {
    effectiveDefense,
    skillPower,
    attributeMultiplier,
    actionDamageMultiplier,
    preTruncationDamage,
    finalDamage: Math.max(1, Math.floor(preTruncationDamage)),
  };
}
