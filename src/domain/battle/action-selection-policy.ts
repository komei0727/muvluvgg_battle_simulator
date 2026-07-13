import type { BattleUnit } from "./battle-unit.js";
import { resolveTargets } from "./target-selection-policy.js";
import type { SkillDefinition } from "../catalog/skill-definition.js";
import { DomainValidationError } from "../shared/errors.js";

export type ActionSelectionResult =
  | { readonly kind: "SKILL"; readonly skill: SkillDefinition }
  | { readonly kind: "WAIT" };

/** R-TGT-01 #4: 各targetBindingが1体以上の候補を持つかどうかで判定する。 */
function hasResolvableTargets(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): boolean {
  return skill.resolution.targetBindings.every(
    (binding) => resolveTargets(binding.selector, actor, allUnits).length > 0,
  );
}

/**
 * R-ACT-02（基本形）: クールタイム・気絶・凍結（M7）は未実装のため、APと
 * 発動条件、対象候補の有無だけを評価する。
 */
function isUsable(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): boolean {
  if (skill.cost.amount > actor.currentAp) {
    return false;
  }
  if (skill.activationCondition.kind !== "TRUE") {
    throw new DomainValidationError(
      "skill.activationCondition",
      `kind "${skill.activationCondition.kind}" is not supported by this basic ActionSelectionPolicy (ConditionEvaluator is M7 scope)`,
    );
  }
  return hasResolvableTargets(skill, actor, allUnits);
}

/**
 * `ActionSelectionPolicy` 基本形 (`05_ドメインモデル.md`)。R-ACT-02: ASを
 * 定義順に評価し、最初に使用可能なものを選ぶ。候補がなければ待機する。
 */
export function selectAsCandidate(
  activeSkills: readonly SkillDefinition[],
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): ActionSelectionResult {
  for (const skill of activeSkills) {
    if (isUsable(skill, actor, allUnits)) {
      return { kind: "SKILL", skill };
    }
  }
  return { kind: "WAIT" };
}
