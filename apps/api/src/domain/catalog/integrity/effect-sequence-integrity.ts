import type { EffectActionDefinitionId } from "../definitions/catalog-ids.js";
import type { ConditionDefinition } from "../definitions/condition-definition.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { EffectSequence, EffectStepDefinition } from "../definitions/effect-sequence.js";
import {
  collectEffectActionReferences,
  EFFECT_STEP_ROOT_PATH,
} from "../definitions/effect-step-walk.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import { conditionUsesGrantedBy } from "./condition-inspection.js";
import {
  collectBranchTargetStateUnboundedReferencePaths,
  collectMixedStepTargetSetConditionPaths,
  stepsUseGrantedBy,
} from "./effect-step-inspection.js";
import {
  buildBindingSelectors,
  targetReferenceIsSingleUnit,
} from "./target-reference-cardinality.js";

/**
 * 1つの`EffectSequence`（Skillの`resolution`/`chargeRelease`、Memoryの
 * `triggeredEffects[].effectSequence`）に対して同じ規則で行う検証。Skill側と
 * Memory側の双方から呼ばれる。
 */

export function validateEffectActionReferences(
  steps: readonly EffectStepDefinition[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  targetId: string,
  violations: CatalogIntegrityViolation[],
): void {
  for (const ref of collectEffectActionReferences(steps)) {
    if (!effectActions.has(ref.effectActionDefinitionId)) {
      violations.push({
        targetId,
        rule: "DANGLING_REFERENCE",
        message: `references undefined EffectActionDefinition "${ref.effectActionDefinitionId}"`,
      });
    }
  }
}

/**
 * `TARGET_HAS_EFFECT.effectActionDefinitionIds`が実在の`EffectActionDefinition`を
 * 指しているかを、条件を置けるすべての位置（Skillの`triggers[]`／
 * `counterUpdates[].trigger`／`activationCondition`／EffectSequence内のstep条件、
 * Memoryの`trigger`／EffectSequence、`DurationDefinition`の`expiration.conditions`と
 * `counterUpdates[].trigger.condition`）で検証する。存在しないIDを指す条件は実行時に
 * 一切一致しないsilent no-opになるため、`EFFECT_IMMUNITY`/`REMOVE_EFFECTS`の
 * payload参照と同じ`DANGLING_REFERENCE`で拒否する。
 */
export function validateConditionEffectActionReferences(
  references: readonly EffectActionDefinitionId[],
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  for (const referencedId of references) {
    if (!effectActions.has(referencedId)) {
      violations.push({
        targetId: ownerId,
        rule: "DANGLING_REFERENCE",
        message: `TARGET_HAS_EFFECT.effectActionDefinitionIds references undefined EffectActionDefinition "${referencedId}"`,
      });
    }
  }
}

export function validateMixedStepTargetSetCondition(
  steps: readonly EffectStepDefinition[],
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  for (const path of collectMixedStepTargetSetConditionPaths(steps, EFFECT_STEP_ROOT_PATH)) {
    violations.push({
      targetId: ownerId,
      rule: "MIXED_STEP_TARGET_SET_CONDITION",
      message: `${path} combines TARGET_SET_COUNT with a TARGET_STATE/TARGET_HAS_MARKER/TARGET_HAS_EFFECT (regardless of which TargetReference it references) — per-target and step-wide condition scopes cannot be mixed in the same condition tree (RES-004集合条件, Issue #227)`,
    });
  }
}

export function validateBranchTargetStateUnboundedReference(
  sequence: EffectSequence,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  for (const path of collectBranchTargetStateUnboundedReferencePaths(
    sequence.steps,
    EFFECT_STEP_ROOT_PATH,
    buildBindingSelectors(sequence.targetBindings),
  )) {
    violations.push({
      targetId: ownerId,
      rule: "BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE",
      message: `${path}: BRANCH's condition evaluates TARGET_STATE/TARGET_HAS_MARKER/TARGET_HAS_EFFECT against a TargetReference that is not guaranteed to resolve to at most one unit (only SELF, TRIGGER_SOURCE, or a BINDING whose selector has kind SELECT and count 1 are supported — BRANCH has no per-target evaluation context to quantify over multiple units, Issue #230)`,
    });
  }
}

/**
 * R-LNK-01/02（DMG-007、Issue #187）: `APPLY_DAMAGE_LINK.linkTo`が`BINDING`の場合、
 * その`targetBindingId`は**この効果アクションを使うEffectSequence**が宣言していなければ
 * ならない。`EffectActionDefinition`はSkillから独立した定義であり自分の使われ方を
 * 知らないため、Factoryの`createTargetReference`にはbinding scopeを渡せない
 * （`APPLY_REFLECT`等と同じ制約）。宣言のないbindingを指すリンクは付与時点で
 * 解決先が引けず、`EffectApplied`は成功するのにリンクが一度も作用しない
 * silent no-opになるためロード時に拒否する。
 *
 * 解決先は単一ユニット（`AppliedEffect.damageLink.linkToUnitId`）であるため、
 * `selectorGuaranteesAtMostOneUnit`を満たすbindingだけを許す — 複数体へ解決する
 * bindingを指すと「どの1体をリンク先にしたか」が定義から読めなくなる。
 */
export function validateDamageLinkBindingReferences(
  sequence: EffectSequence,
  ownerId: string,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  const bindingSelectors = buildBindingSelectors(sequence.targetBindings);
  for (const ref of collectEffectActionReferences(sequence.steps)) {
    const effectAction = effectActions.get(ref.effectActionDefinitionId);
    if (effectAction?.kind !== "APPLY_DAMAGE_LINK") {
      continue;
    }
    const linkTo = effectAction.payload.linkTo;
    if (linkTo.kind !== "BINDING") {
      continue;
    }
    if (!targetReferenceIsSingleUnit(linkTo, bindingSelectors)) {
      violations.push({
        targetId: ownerId,
        rule: "DAMAGE_LINK_UNBOUNDED_BINDING",
        message: `references APPLY_DAMAGE_LINK "${ref.effectActionDefinitionId}" whose linkTo BINDING "${linkTo.targetBindingId ?? ""}" is not a targetBinding of this EffectSequence that resolves to at most one unit (a damage link burns a single linkToUnitId at grant time, R-LNK-01/02, DMG-007)`,
      });
    }
  }
}

/**
 * `TARGET_HAS_EFFECT.grantedBy`はSkillのtrigger条件（`triggers[]`／
 * `counterUpdates[].trigger`）の中でしか評価できない。EffectSequence内の条件
 * （`stepCondition`/`targetCondition`/BRANCHの`condition`）と`activationCondition`の
 * evaluatorは評価元ユニットを受け取らないため、そこへ書くと「一致しようのない条件」
 * として黙って常に偽になる（DMG-007、Issue #187）。
 */
export function validateGrantedByScope(
  sequence: EffectSequence,
  activationCondition: ConditionDefinition | undefined,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  if (
    !stepsUseGrantedBy(sequence.steps) &&
    (activationCondition === undefined || !conditionUsesGrantedBy(activationCondition))
  ) {
    return;
  }
  violations.push({
    targetId: ownerId,
    rule: "GRANTED_BY_OUTSIDE_TRIGGER",
    message:
      'TARGET_HAS_EFFECT.grantedBy is only evaluable inside a Skill trigger condition (triggers[]/counterUpdates[].trigger), where the evaluating unit is known; an EffectSequence or activationCondition evaluator has no "self" to compare AppliedEffect.sourceId against and the condition would silently never match (DMG-007, Issue #187)',
  });
}
