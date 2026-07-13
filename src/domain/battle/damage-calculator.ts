import { resolveAttributeMultiplier } from "./attribute-affinity-policy.js";
import { createPercentage } from "./percentage.js";
import type { Attribute } from "../catalog/catalog-enums.js";
import type { FormulaDefinition } from "../catalog/formula-definition.js";
import { DomainValidationError } from "../shared/errors.js";

export interface DamageCalculationInput {
  readonly attackerAttack: number;
  readonly attackerAttribute: Attribute;
  readonly attackerAffinityBonus: number;
  readonly defenderDefense: number;
  readonly defenderAttribute: Attribute;
  /** R-DMG-01の実効防御力に使う。0なら通常処理、1なら防御力を全量無視する。 */
  readonly defenseIgnoreRate: number;
  /** R-DMG-01: `SKILL_POWER`だけをスキル威力として評価する（他の種別はM7のFormulaEvaluator範囲）。 */
  readonly skillPowerFormula: FormulaDefinition;
  /** R-DMG-01のAction内追加ダメージ倍率。空配列のみ対応（非空はM7のFormulaEvaluator範囲）。 */
  readonly damageModifiers: readonly FormulaDefinition[];
  /** `CriticalPolicy`が解決済みの会心倍率（R-CRT-02）。 */
  readonly criticalMultiplier: number;
}

function resolveSkillPower(formula: FormulaDefinition): number {
  if (formula.kind !== "SKILL_POWER") {
    throw new DomainValidationError(
      "skillPowerFormula.kind",
      `kind "${formula.kind}" is not supported by this basic DamageCalculator (general FormulaEvaluator is M7 scope)`,
    );
  }
  return formula.power;
}

function resolveActionDamageMultiplier(damageModifiers: readonly FormulaDefinition[]): number {
  if (damageModifiers.length > 0) {
    throw new DomainValidationError(
      "damageModifiers",
      "non-empty damageModifiers are not supported by this basic DamageCalculator (evaluating them requires the FormulaEvaluator/AppliedEffect system, M7 scope)",
    );
  }
  return 1;
}

/**
 * `DamageCalculator` (R-DMG-01, R-DMG-02の一部)。基礎値、スキル威力、属性倍率、
 * 会心倍率、Action内追加ダメージ倍率から計算ダメージを求め、最終切り捨てと
 * 最低1ダメージ（R-DMG-02の一部）を適用する。与ダメージ倍率・被ダメージ倍率
 * (R-DMG-04, AppliedEffectが必要)とダメージ無効効果(R-DMG-02の残り)は
 * M7未実装のため、この関数の対象外。
 */
export function calculateDamage(input: DamageCalculationInput): number {
  const effectiveDefense = input.defenderDefense * (1 - input.defenseIgnoreRate);
  const baseDamage = Math.max(0, input.attackerAttack - effectiveDefense);

  const skillPower = resolveSkillPower(input.skillPowerFormula);
  const attributeMultiplier = resolveAttributeMultiplier(
    input.attackerAttribute,
    input.defenderAttribute,
    createPercentage(input.attackerAffinityBonus),
  );
  const actionDamageMultiplier = resolveActionDamageMultiplier(input.damageModifiers);

  const calculated =
    baseDamage *
    skillPower *
    attributeMultiplier *
    input.criticalMultiplier *
    actionDamageMultiplier;

  return Math.max(1, Math.floor(calculated));
}
