import type { BattleUnit } from "../model/battle-unit.js";
import { resolveTargets } from "../targeting/target-selection-policy.js";
import type { SkillDefinitionId, TargetBindingId } from "../../catalog/definitions/catalog-ids.js";
import type { SkillDefinition } from "../../catalog/definitions/skill-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

export type ActionSelectionResult =
  | { readonly kind: "SKILL"; readonly skill: SkillDefinition }
  | { readonly kind: "WAIT" };

/**
 * R-TGT-01 #4: 各targetBindingが1体以上の候補を持つかどうかで判定する。
 * R-TGT-09/10: `base: BINDING`が先行bindingを参照できるよう、定義順に解決した
 * bindingを積み上げながら判定する（後続bindingが不成立でも先行分は評価済み）。
 */
export function hasResolvableTargets(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): boolean {
  const resolvedBindingUnits = new Map<TargetBindingId, readonly BattleUnit[]>();
  for (const binding of skill.resolution.targetBindings) {
    const units = resolveTargets(binding.selector, actor, allUnits, resolvedBindingUnits);
    resolvedBindingUnits.set(binding.targetBindingId, units);
    if (units.length === 0) {
      return false;
    }
  }
  return true;
}

/**
 * R-ACT-02「クールタイムが0」: 指定スキルの残数が1以上（COOLING）かどうかを
 * 判定する。未登録（READY/未使用）のスキルは残数0として扱う。M6のPS発動直前
 * 再確認（`06_戦闘状態遷移.md`）でも同じ判定を再利用できるよう、
 * `ActionSelectionPolicy`から独立した関数として公開する。
 */
export function isCoolingDown(actor: BattleUnit, skillDefinitionId: SkillDefinitionId): boolean {
  return (actor.cooldowns[skillDefinitionId]?.remaining ?? 0) >= 1;
}

/**
 * R-ACT-02（基本形）: クールタイム、APと発動条件、対象候補の有無を評価する。
 * 気絶・凍結（M7）は未実装のため対象外。
 */
function isUsable(
  skill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): boolean {
  if (isCoolingDown(actor, skill.skillDefinitionId)) {
    return false;
  }
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

/**
 * R-ACT-01 #5（EX予約）: EXはコスト（AP・クールタイム）判定を持たず（`R-ACT-03`
 * 「EX: EXゲージ全量、APは消費しない」、予約時点でゲージは既に満タン確定）、
 * 対象候補の有無だけが発動可否を左右する（`Q-BTL-06`「EXを使用できない場合は
 * EXゲージを全量消費して待機する」）。
 */
export function isExUsable(
  exSkill: SkillDefinition,
  actor: BattleUnit,
  allUnits: readonly BattleUnit[],
): boolean {
  if (exSkill.activationCondition.kind !== "TRUE") {
    throw new DomainValidationError(
      "exSkill.activationCondition",
      `kind "${exSkill.activationCondition.kind}" is not supported by this basic ActionSelectionPolicy (ConditionEvaluator is M7 scope)`,
    );
  }
  return hasResolvableTargets(exSkill, actor, allUnits);
}
