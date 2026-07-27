import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import { compareWithOperator } from "../skill/comparison-operator.js";
import { evaluateFormula, type FormulaEvaluationContext } from "../skill/formula-evaluator.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { BattleUnit } from "../model/battle-unit.js";

export interface DamageImmunityOutcome {
  readonly nullified: boolean;
  readonly nullifiedByEffectInstanceId?: EffectInstanceId;
  readonly nullifiedByEffectActionDefinitionId?: EffectActionDefinitionId;
}

/**
 * G-06: `damageThreshold`未指定なら無条件で無効化する。指定時は、判定時点の
 * incoming raw damage（`calculateDamage`が確定した最終ダメージ、R-DMG-02の
 * 残りfinalize前）が`op`で`formula`の評価結果と比較して真になる場合だけ
 * 無効化する（例: `GT` + `CURRENT_HP_RATIO(TARGET, 0.35)`は対象の現在HPの
 * 35%を超える一撃だけを防ぐ、雑魚チップダメージには反応しない結界）。
 */
function immunityThresholdMatches(
  effect: AppliedEffect,
  rawDamage: number,
  context: FormulaEvaluationContext,
): boolean {
  const threshold = effect.statusDetails?.damageThreshold;
  if (threshold === undefined) {
    return true;
  }
  const thresholdValue = evaluateFormula(threshold.formula, context, "damageThreshold.formula");
  return compareWithOperator(rawDamage, threshold.op, thresholdValue);
}

/**
 * R-DMG-02「ダメージ無効効果がある場合も結果を1とする」。対象が持つ有効な
 * DAMAGE_IMMUNITY `AppliedEffect`を付与順（`appliedEffects`の配列順）に判定し、
 * 最初に条件を満たした効果が無効化を成立させる。`calculateDamage`自身は
 * この判定を知らない（`AppliedEffect`を受け取らない純粋な数値計算のため）—
 * 呼び出し側がこの関数の結果で`finalDamage`を1へ上書きする。
 */
export function resolveDamageImmunity(
  target: BattleUnit,
  rawDamage: number,
  context: FormulaEvaluationContext,
): DamageImmunityOutcome {
  for (const effect of target.appliedEffects) {
    if (effect.statusKind !== "DAMAGE_IMMUNITY") {
      continue;
    }
    if (!immunityThresholdMatches(effect, rawDamage, context)) {
      continue;
    }
    return {
      nullified: true,
      nullifiedByEffectInstanceId: effect.effectInstanceId,
      nullifiedByEffectActionDefinitionId: effect.effectActionDefinitionId,
    };
  }
  return { nullified: false };
}
