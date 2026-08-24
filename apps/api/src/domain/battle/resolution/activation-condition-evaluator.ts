import { evaluateEffectStepCondition } from "../skill/effect-step-condition-evaluator.js";
import type { ActivationConditionEvaluator } from "../action/action-selection-policy.js";
import type { TargetReference } from "../../catalog/definitions/references.js";
import { DomainValidationError } from "../../shared/errors.js";

/**
 * R-ACT-02「発動条件を満たす」（CAP_ACTION_ACTIVATION_CONDITION、Issue #180）:
 * AS/EXの`activationCondition`を、行動選択時にTargetBinding/Area/TargetFilterで
 * 絞り込んだ最新の生存対象集合に対して評価する。`evaluateEffectStepCondition`
 * （ACTION stepの`stepCondition`/BRANCHの`condition`と共通の評価器、
 * `domain/battle/skill`）をそのまま再利用し、`TargetReference`は`SELF`
 * （使用者自身）と`BINDING`（この呼び出しより前に解決済みのtargetBindings）だけを
 * 解決する — AS/EX選択はPS/Memoryのようなトリガーイベントや直前結果を持たないため、
 * `TRIGGER_SOURCE`/`TRIGGER_TARGET`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`は
 * Catalog-authoring errorとして明確な例外を投げる。
 *
 * `domain/battle/action`（`action-selection-policy.ts`）は`domain/battle/skill`
 * へ依存できない（モジュール境界、eslint.config.mjs — actionとskillは並列で
 * どちらも他方へ依存できない）ため、両方へ依存できる`domain/battle/resolution`が
 * この実装を持ち、`ActivationConditionEvaluator`として注入する
 * （`action-phase-resolver.ts`）。
 */
export const evaluateActivationCondition: ActivationConditionEvaluator = (
  condition,
  actor,
  resolvedBindings,
  unitDefinitions,
) => {
  return evaluateEffectStepCondition(
    condition,
    undefined,
    undefined,
    (reference: TargetReference) => {
      if (reference.kind === "SELF") {
        return [actor];
      }
      if (reference.kind === "BINDING" && reference.targetBindingId !== undefined) {
        const units = resolvedBindings.get(reference.targetBindingId);
        if (units === undefined) {
          throw new DomainValidationError(
            "skill.activationCondition",
            `references an unresolved TargetBindingId "${reference.targetBindingId}"`,
          );
        }
        return units;
      }
      throw new DomainValidationError(
        "skill.activationCondition",
        `TargetReference kind "${reference.kind}" is not supported by AS/EX activationCondition evaluation (no triggering event or prior action exists at action-selection time)`,
      );
    },
    unitDefinitions,
  );
};
