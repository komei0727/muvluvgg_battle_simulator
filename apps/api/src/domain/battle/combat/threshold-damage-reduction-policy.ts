import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import { compareWithOperator } from "../skill/comparison-operator.js";
import { evaluateFormula, type FormulaEvaluationContext } from "../skill/formula-evaluator.js";
import type { BattleUnit } from "../model/battle-unit.js";
import { evaluateDamageModCondition } from "./damage-modifier-policy.js";

export interface ThresholdDamageReductionInput {
  readonly attacker: BattleUnit;
  readonly defender: BattleUnit;
  readonly damageType: DamageType;
  /** R-DMG-02 #1の切り捨てまで確定した入射ダメージ（`resolveDamageImmunity`と同じ判定素材）。 */
  readonly incomingDamage: number;
  /** R-DMG-03: 軽減方向の補正だけを割合で無視する（`composeDamageModifiers`と同じ扱い）。 */
  readonly damageReductionIgnoreRate: number;
  readonly formulaContext: FormulaEvaluationContext;
}

export interface ThresholdDamageReductionOutcome {
  /** 成立した閾値付き補正の独立倍率 `max(0, 1 + 合計補正)`。成立0件なら1。 */
  readonly multiplier: number;
  /** 実際に適用された（=消費対象の）インスタンス。付与順。 */
  readonly appliedEffects: readonly {
    readonly effectInstanceId: EffectInstanceId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
  }[];
}

/**
 * R-DMG-07: 防御側が保持する`damageThreshold`付き`APPLY_DAMAGE_MOD`（`INCOMING`のみ、
 * Catalogロード時に強制）のうち、`damageType`・動的条件を満たし、確定した入射ダメージが
 * 閾値比較で真になるインスタンスを合算し、独立倍率として返す。R-DMG-04の通常合成
 * （`composeDamageModifiers`）はこれらのインスタンスを除外している — 通常合成は入射
 * ダメージ確定前に走るため、閾値の判定素材が存在しない。
 *
 * 消費（R-EFF-07の`INCOMING_HIT`）は「実際に軽減が適用されたヒット」でだけ行うため、
 * 呼び出し側が`appliedEffects`を使ってインスタンス指定で消費する（R-HIT-04のNヒット回避と
 * 同じ機構）。`consumptionRemaining`が0のインスタンスは失効待ちであり参加しない。
 * 状態変更もイベント発行も行わない純粋関数。
 */
export function resolveThresholdDamageReduction(
  input: ThresholdDamageReductionInput,
): ThresholdDamageReductionOutcome {
  const appliedEffects: {
    readonly effectInstanceId: EffectInstanceId;
    readonly effectActionDefinitionId: EffectActionDefinitionId;
  }[] = [];
  let total = 0;
  for (const effect of input.defender.appliedEffects) {
    const modifier = effect.damageModifier;
    const threshold = modifier?.damageThreshold;
    if (modifier === undefined || threshold === undefined || modifier.direction !== "INCOMING") {
      continue;
    }
    if (modifier.damageType !== null && modifier.damageType !== input.damageType) {
      continue;
    }
    if (
      effect.duration.consumptionRemaining !== undefined &&
      effect.duration.consumptionRemaining <= 0
    ) {
      continue;
    }
    if (
      modifier.condition !== undefined &&
      !evaluateDamageModCondition(modifier.condition, input.defender, input.attacker)
    ) {
      continue;
    }
    const thresholdValue = evaluateFormula(
      threshold.formula,
      input.formulaContext,
      "damageThreshold.formula",
    );
    if (!compareWithOperator(input.incomingDamage, threshold.op, thresholdValue)) {
      continue;
    }
    const ignoresReduction = effect.magnitude < 0;
    total += ignoresReduction
      ? effect.magnitude * (1 - input.damageReductionIgnoreRate)
      : effect.magnitude;
    appliedEffects.push({
      effectInstanceId: effect.effectInstanceId,
      effectActionDefinitionId: effect.effectActionDefinitionId,
    });
  }
  if (appliedEffects.length === 0) {
    return { multiplier: 1, appliedEffects: [] };
  }
  return { multiplier: Math.max(0, 1 + total), appliedEffects };
}
