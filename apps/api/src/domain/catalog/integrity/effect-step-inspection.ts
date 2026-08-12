import type { EffectActionDefinitionId } from "../definitions/catalog-ids.js";
import type { ConditionDefinition } from "../definitions/condition-definition.js";
import type { EffectStepDefinition } from "../definitions/effect-sequence.js";
import {
  collectEffectSteps,
  effectStepOwnConditions,
  someEffectStep,
} from "../definitions/effect-step-walk.js";
import type { TargetSelectorDefinition } from "../definitions/target-selector-definition.js";
import {
  collectConditionEffectActionReferences,
  collectTargetStateOrMarkerReferences,
  conditionContainsDamageMaxHpRatio,
  conditionContainsEventPayload,
  conditionContainsTargetReferenceKind,
  conditionContainsTargetSetCount,
  conditionContainsTargetStateOrMarker,
  conditionUsesGrantedBy,
} from "./condition-inspection.js";
import { targetReferenceIsSingleUnit } from "./target-reference-cardinality.js";

/**
 * EffectStepツリー全体に対する述語・path収集。降下そのものは
 * `definitions/effect-step-walk.ts`が唯一の経路として持ち、ここは
 * 「1 stepをどう見るか」だけを定義する。
 */

/** 直前のEffectAction結果を参照する`TargetReference.kind`（R-SKL-08）。 */
export const LAST_RESULT_TARGET_KINDS: ReadonlySet<string> = new Set([
  "LAST_ACTION_TARGETS",
  "LAST_DAMAGED_TARGETS",
]);

/** EffectStepツリーが宣言する全conditionのいずれかが`predicate`を満たすか。 */
export function stepsSomeCondition(
  steps: readonly EffectStepDefinition[],
  predicate: (condition: ConditionDefinition) => boolean,
): boolean {
  return someEffectStep(steps, (step) => effectStepOwnConditions(step).some(predicate));
}

export function containsStepKind(
  steps: readonly EffectStepDefinition[],
  kinds: ReadonlySet<EffectStepDefinition["kind"]>,
): boolean {
  return someEffectStep(steps, (step) => kinds.has(step.kind));
}

/** ACTIONの`target`と、全stepのconditionに埋め込まれた`TargetReference`の両方を見る。 */
export function stepsContainTargetReferenceKinds(
  steps: readonly EffectStepDefinition[],
  kinds: ReadonlySet<string>,
): boolean {
  return someEffectStep(
    steps,
    (step) =>
      (step.kind === "ACTION" && kinds.has(step.target.kind)) ||
      effectStepOwnConditions(step).some((condition) =>
        conditionContainsTargetReferenceKind(condition, kinds),
      ),
  );
}

/**
 * Issue #230: ACTIONは`stepCondition`/`targetCondition`のどちらか一方でも非TRUE
 * なら対象とする — 実際に対象別filterを使うかどうかに関わらず、ACTIONが何らかの
 * 条件ロジックを宣言していること自体を見る。BRANCHは`target`を持たずconditionが
 * 常にstep-wideのためこの区別が無い。
 */
export function stepsContainNonTrueCondition(steps: readonly EffectStepDefinition[]): boolean {
  return stepsSomeCondition(steps, (condition) => condition.kind !== "TRUE");
}

export function stepsContainSetCondition(steps: readonly EffectStepDefinition[]): boolean {
  // ACTIONのTARGET_SET_COUNTは`stepCondition`にしか置けない（`targetCondition`は
  // TRUE/AND/OR/NOT/TARGET_STATE/TARGET_HAS_MARKER/TARGET_HAS_EFFECT/EVENT_PAYLOADへ
  // スキーマ上制限される、`condition-definition.ts`の`TARGET_CONDITION_KINDS`）ため、
  // 他の条件走査と違い`effectStepOwnConditions`ではなく`stepCondition`だけを見る。
  return someEffectStep(
    steps,
    (step) =>
      (step.kind === "ACTION" && conditionContainsTargetSetCount(step.stepCondition)) ||
      (step.kind === "BRANCH" && conditionContainsTargetSetCount(step.condition)),
  );
}

/**
 * CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）。ACTIONの`EVENT_PAYLOAD`は
 * `stepCondition`・`targetCondition`のどちらにも置ける（`TARGET_CONDITION_KINDS`が
 * 許可する）ため、両方を見る。
 */
export function stepsContainEventPayloadCondition(steps: readonly EffectStepDefinition[]): boolean {
  return stepsSomeCondition(steps, conditionContainsEventPayload);
}

/**
 * R-PS-01: `DAMAGE_MAX_HP_RATIO`はtrigger条件専用のため、skillTypeを問わず
 * すべてのresolution step位置から拒否する（`conditionContainsDamageMaxHpRatio`参照）。
 */
export function stepsContainDamageMaxHpRatioCondition(
  steps: readonly EffectStepDefinition[],
): boolean {
  return stepsSomeCondition(steps, conditionContainsDamageMaxHpRatio);
}

export function stepsUseGrantedBy(steps: readonly EffectStepDefinition[]): boolean {
  return stepsSomeCondition(steps, conditionUsesGrantedBy);
}

export function collectStepConditionEffectActionReferences(
  steps: readonly EffectStepDefinition[],
): readonly EffectActionDefinitionId[] {
  return collectEffectSteps(steps, (step) =>
    effectStepOwnConditions(step).flatMap(collectConditionEffectActionReferences),
  );
}

/**
 * `TARGET_STATE`/`TARGET_HAS_MARKER`/`TARGET_HAS_EFFECT`と`TARGET_SET_COUNT`を
 * 同じ条件木へ混在させているBRANCHのpath。`ACTION`は`stepCondition`/
 * `targetCondition`へ分離済みで（前者は`TARGET_STATE`系を、後者は
 * `TARGET_SET_COUNT`をスキーマ上受理しない）混在が構造的に不可能だが、`BRANCH`は
 * `target`を持たず単一の`condition`が常にstep-wideのままであり、
 * `resolveBranchStep`（`effect-action-group-resolver.ts`）は`targetContext: undefined`で
 * 評価する。量化の位置に依存して結果が変わり得るうえ、評価器が対象コンテキストを
 * 持たず例外になるため拒否する。
 */
export function collectMixedStepTargetSetConditionPaths(
  steps: readonly EffectStepDefinition[],
  path: string,
): readonly string[] {
  return collectEffectSteps(
    steps,
    (step, stepPath) =>
      step.kind === "BRANCH" &&
      conditionContainsTargetStateOrMarker(step.condition) &&
      conditionContainsTargetSetCount(step.condition)
        ? [`${stepPath}.condition`]
        : [],
    path,
  );
}

/**
 * BRANCHの`condition`が、高々1体へ解決される保証のない`TargetReference`に対して
 * `TARGET_STATE`/`TARGET_HAS_MARKER`/`TARGET_HAS_EFFECT`を評価しているpath。
 * `resolveBranchStep`は`EffectStepTargetContext`を持たないため、参照が高々1体に
 * 解決される場合に限りその1体（0体ならfalse）を直接評価する
 * （`effect-step-condition-evaluator.ts`）。
 */
export function collectBranchTargetStateUnboundedReferencePaths(
  steps: readonly EffectStepDefinition[],
  path: string,
  bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition>,
): readonly string[] {
  return collectEffectSteps(
    steps,
    (step, stepPath) =>
      step.kind === "BRANCH"
        ? collectTargetStateOrMarkerReferences(step.condition, `${stepPath}.condition`)
            .filter(({ reference }) => !targetReferenceIsSingleUnit(reference, bindingSelectors))
            .map(({ path: referencePath }) => referencePath)
        : [],
    path,
  );
}
