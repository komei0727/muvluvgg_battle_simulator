import type { CapabilityDefinition } from "../capability/capability-definition.js";
import type {
  CapabilityId,
  EffectActionDefinitionId,
  MemoryDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../definitions/catalog-ids.js";
import {
  DIAGNOSTIC_ONLY_EVENT_TYPES,
  EVENT_TYPE_CATEGORIES,
} from "../definitions/catalog-event-types.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { ConditionDefinition } from "../definitions/condition-definition.js";
import type { DurationDefinition } from "../definitions/duration-definition.js";
import type { FormulaDefinition } from "../definitions/formula-definition.js";
import type {
  EffectActionReference,
  EffectSequence,
  EffectStepDefinition,
} from "../definitions/effect-sequence.js";
import type { MemoryDefinition } from "../definitions/memory-definition.js";
import { toReadonlyMap } from "../../shared/readonly-map.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type { TriggerDefinition } from "../definitions/trigger-definition.js";
import type {
  TargetFilterDefinition,
  TargetSelectorDefinition,
} from "../definitions/target-selector-definition.js";
import type { TargetReference } from "../definitions/references.js";
import type { UnitDefinition } from "../definitions/unit-definition.js";

/**
 * Whole-Catalog structural/semantic validation (`11_インフラストラクチャ設計.md`
 * の読み込み段階: Resolve → Semantic). Operates on already Shape-and-Domain
 * validated per-item Definitions (`catalog-definition-mapper.ts`); this module
 * only checks invariants that require seeing every file at once — ID
 * uniqueness across a whole file, Unit→Skill / Skill・Memory→EffectAction
 * reference existence, EX skill cost agreement, `requiredCapabilities`
 * existence, and the `TriggerDefinition.eventType` closed list that
 * `trigger-definition.ts` explicitly defers here (issue #7).
 */

export const VIOLATION_RULES = [
  "DUPLICATE_ID",
  "DUPLICATE_SKILL_REFERENCE",
  "DANGLING_REFERENCE",
  "TYPE_MISMATCH",
  "EX_COST_MISMATCH",
  "UNKNOWN_CAPABILITY",
  "UNSUPPORTED_SCHEMA_CAPABILITY",
  "INVALID_CAPABILITY_VERIFICATION",
  "UNKNOWN_EVENT_TYPE",
  "EVENT_CATEGORY_MISMATCH",
  "UNOWNED_SKILL_REFERENCE",
  "MISSING_REQUIRED_CAPABILITY",
  "UNSUPPORTED_MARKER_DURATION",
  "UNSUPPORTED_CONTINUOUS_HEAL_TIMING",
  "UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET",
  "UNSUPPORTED_DYNAMIC_DURATION_REAPPLY",
  "UNSUPPORTED_SOURCE_DEFEATED_REMOVAL",
  "MISSING_PRECEDING_RESULT",
  "MIXED_STEP_TARGET_SET_CONDITION",
  "BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE",
  "EVENT_PAYLOAD_REQUIRES_PS_SKILL",
  "MEMORY_REQUIRES_SOURCE_UNIT",
] as const;
export type CatalogIntegrityRule = (typeof VIOLATION_RULES)[number];

export interface CatalogIntegrityViolation {
  /** The definition ID this violation is diagnosed against (`14_Catalog定義スキーマ.md` の ID体系). */
  readonly targetId: string;
  readonly rule: CatalogIntegrityRule;
  readonly message: string;
}

/**
 * Raised by `buildCatalogIndex` with every violation found in one pass
 * (`09_アプリケーション設計.md` の Command検証と同様、可能な限りまとめて返す)
 * so a Catalog author sees every problem, not just the first.
 */
export class CatalogIntegrityError extends Error {
  readonly violations: readonly CatalogIntegrityViolation[];

  constructor(violations: readonly CatalogIntegrityViolation[]) {
    super(
      `Catalog integrity validation failed with ${violations.length} violation(s): ` +
        violations.map((v) => `[${v.rule}] ${v.targetId}: ${v.message}`).join("; "),
    );
    this.name = "CatalogIntegrityError";
    this.violations = violations;
  }
}

export interface CatalogDefinitions {
  readonly units: readonly UnitDefinition[];
  readonly skills: readonly SkillDefinition[];
  readonly effectActions: readonly EffectActionDefinition[];
  readonly memories: readonly MemoryDefinition[];
  readonly capabilities: readonly CapabilityDefinition[];
}

export interface CatalogIndex {
  readonly units: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
  readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;
  readonly memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>;
  readonly capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>;
}

function indexById<Id extends string, Def>(
  definitions: readonly Def[],
  idOf: (def: Def) => Id,
  typeName: string,
  violations: CatalogIntegrityViolation[],
): Map<Id, Def> {
  const map = new Map<Id, Def>();
  for (const def of definitions) {
    const id = idOf(def);
    if (map.has(id)) {
      violations.push({
        targetId: id,
        rule: "DUPLICATE_ID",
        message: `duplicate ${typeName} id "${id}"`,
      });
      continue;
    }
    map.set(id, def);
  }
  return map;
}

export function collectEffectActionReferences(
  steps: readonly EffectStepDefinition[],
): readonly EffectActionReference[] {
  const refs: EffectActionReference[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "ACTION":
        refs.push(...step.actions);
        break;
      case "BRANCH":
        refs.push(...collectEffectActionReferences(step.thenSteps));
        refs.push(...collectEffectActionReferences(step.elseSteps));
        break;
      case "RANDOM_BRANCH":
        for (const branch of step.branches) {
          refs.push(...collectEffectActionReferences(branch.steps));
        }
        break;
      case "REPEAT":
        refs.push(...collectEffectActionReferences(step.steps));
        break;
    }
  }
  return refs;
}

function validateEffectActionReferences(
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

function containsStepKind(
  steps: readonly EffectStepDefinition[],
  kinds: ReadonlySet<EffectStepDefinition["kind"]>,
): boolean {
  for (const step of steps) {
    if (kinds.has(step.kind)) {
      return true;
    }
    if (step.kind === "BRANCH") {
      if (containsStepKind(step.thenSteps, kinds) || containsStepKind(step.elseSteps, kinds)) {
        return true;
      }
    } else if (step.kind === "RANDOM_BRANCH") {
      if (step.branches.some((branch) => containsStepKind(branch.steps, kinds))) {
        return true;
      }
    } else if (step.kind === "REPEAT" && containsStepKind(step.steps, kinds)) {
      return true;
    }
  }
  return false;
}

const BRANCH_REPEAT_STEP_KINDS = new Set<EffectStepDefinition["kind"]>(["BRANCH", "REPEAT"]);
const RANDOM_BRANCH_STEP_KINDS = new Set<EffectStepDefinition["kind"]>(["RANDOM_BRANCH"]);
const TRIGGER_CONTEXT_EVENT_TYPES = new Set([
  "EffectApplied",
  "UnitBeingAttacked",
  // R-DMG-05 #4（DMG-001／Issue #195）: `UnitBeingAttacked`と同じく発生源・対象を
  // 伴うruntime所有のダメージTIMINGイベント。現時点でこれをtriggerにする
  // production定義は存在しないが、追加時に`CAP_TRIGGER_CONTEXT`の宣言漏れを
  // Catalogロード時点で弾く。
  "DamageWillBeApplied",
  "HitPointReduced",
]);
const TRIGGER_CONTEXT_TARGET_KINDS = new Set(["TRIGGER_SOURCE", "TRIGGER_TARGET"]);
const LAST_RESULT_TARGET_KINDS = new Set(["LAST_ACTION_TARGETS", "LAST_DAMAGED_TARGETS"]);
type RuntimeStructuralCapabilityId =
  | "CAP_ACTION_ACTIVATION_CONDITION"
  | "CAP_PASSIVE_ACTIVATION_CONDITION"
  | "CAP_EFFECT_RUNTIME_COUNTER"
  | "CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER"
  | "CAP_EFFECT_STEP_CONDITION"
  | "CAP_EFFECT_STEP_SET_CONDITION"
  | "CAP_MEMORY_TRIGGERED_EFFECT"
  | "CAP_RANDOM_BRANCH"
  | "CAP_RESOLUTION_BRANCH_REPEAT"
  | "CAP_SKILL_RUNTIME_COUNTER"
  | "CAP_TARGET_FILTER_ORDER"
  | "CAP_TARGET_DERIVED_AREA"
  | "CAP_TARGET_BINDING_FALLBACK"
  | "CAP_TRIGGER_CONTEXT"
  | "CAP_TRIGGER_PAYLOAD_IN_RESOLUTION";

function selectorTreeSome(
  selector: TargetSelectorDefinition,
  predicate: (candidate: TargetSelectorDefinition) => boolean,
): boolean {
  return (
    predicate(selector) ||
    (selector.fallback !== undefined && selectorTreeSome(selector.fallback, predicate))
  );
}

/**
 * `ConditionDefinition`内に埋め込まれた`TargetReference`（`TARGET_STATE`/
 * `TARGET_HAS_MARKER`/`POSITION_RELATION`/`TARGET_SET_COUNT`の`target`）を
 * 再帰的に収集する（AND/OR/NOTを辿る）。PRレビュー[P2]（Issue #227）:
 * `stepsContainTargetReferenceKinds`と`walkLastResultDataFlowStep`は従来
 * ACTIONの`step.target`だけを見ており、condition内のTargetReferenceが
 * `TRIGGER_SOURCE`/`TRIGGER_TARGET`（`CAP_TRIGGER_CONTEXT`）や
 * `LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`（`MISSING_PRECEDING_RESULT`）を
 * 参照していても検証を迂回していた。
 */
function collectConditionTargetReferences(
  condition: ConditionDefinition,
): readonly TargetReference[] {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
    case "POSITION_RELATION":
    case "TARGET_SET_COUNT":
      return [condition.target];
    case "AND":
    case "OR":
      return condition.conditions.flatMap((c) => collectConditionTargetReferences(c));
    case "NOT":
      return collectConditionTargetReferences(condition.condition);
    default:
      return [];
  }
}

function conditionContainsTargetReferenceKind(
  condition: ConditionDefinition,
  kinds: ReadonlySet<string>,
): boolean {
  return collectConditionTargetReferences(condition).some((reference) => kinds.has(reference.kind));
}

function stepsContainTargetReferenceKinds(
  steps: readonly EffectStepDefinition[],
  kinds: ReadonlySet<string>,
): boolean {
  for (const step of steps) {
    if (step.kind === "ACTION") {
      if (
        kinds.has(step.target.kind) ||
        conditionContainsTargetReferenceKind(step.stepCondition, kinds) ||
        conditionContainsTargetReferenceKind(step.targetCondition, kinds)
      ) {
        return true;
      }
    } else if (step.kind === "BRANCH") {
      if (
        conditionContainsTargetReferenceKind(step.condition, kinds) ||
        stepsContainTargetReferenceKinds(step.thenSteps, kinds) ||
        stepsContainTargetReferenceKinds(step.elseSteps, kinds)
      ) {
        return true;
      }
    } else if (step.kind === "RANDOM_BRANCH") {
      if (step.branches.some((branch) => stepsContainTargetReferenceKinds(branch.steps, kinds))) {
        return true;
      }
    } else if (step.kind === "REPEAT" && stepsContainTargetReferenceKinds(step.steps, kinds)) {
      return true;
    }
  }
  return false;
}

/**
 * CAP_EFFECT_STEP_CONDITION_SCOPE（Issue #230）: ACTIONは`stepCondition`/
 * `targetCondition`のどちらか一方でも非TRUEなら対象とする（Issue #227以前の
 * 「`condition`が非TRUEなら要求」という広い判定をそのまま維持する — 実際に
 * 対象別filterを使うかどうかに関わらず、ACTIONが何らかの条件ロジックを
 * 宣言していること自体を要求するのがこのCapabilityの既存の運用だったため）。
 * `stepCondition`が`TARGET_SET_COUNT`を含む場合は、これに加えて別Capability
 * （CAP_EFFECT_STEP_SET_CONDITION、`stepsContainSetCondition`）も要求される
 * ため、両方が同時に必要になりうる（Issue #230が可能にした組み合わせ）。
 * BRANCHにはこの区別が無い（`target`を持たずconditionは常にstep-wide）ため、
 * 従来どおり`condition`をそのまま見る。
 */
function stepsContainNonTrueCondition(steps: readonly EffectStepDefinition[]): boolean {
  for (const step of steps) {
    if (
      step.kind === "ACTION" &&
      (step.stepCondition.kind !== "TRUE" || step.targetCondition.kind !== "TRUE")
    ) {
      return true;
    }
    if (step.kind === "BRANCH" && step.condition.kind !== "TRUE") {
      return true;
    }
    if (step.kind === "BRANCH") {
      if (
        stepsContainNonTrueCondition(step.thenSteps) ||
        stepsContainNonTrueCondition(step.elseSteps)
      ) {
        return true;
      }
    } else if (step.kind === "RANDOM_BRANCH") {
      if (step.branches.some((branch) => stepsContainNonTrueCondition(branch.steps))) {
        return true;
      }
    } else if (step.kind === "REPEAT" && stepsContainNonTrueCondition(step.steps)) {
      return true;
    }
  }
  return false;
}

/**
 * R-SKL-06/07（CAP_EFFECT_STEP_SET_CONDITION、Issue #227 RES-004集合条件）:
 * `condition`のどこかに`TARGET_SET_COUNT`が含まれるか（AND/OR/NOTを再帰的に見る）。
 * `domain/catalog`は`domain/battle`へ依存できない（module境界）ため、
 * `effect-step-condition-evaluator.ts`の`conditionReferencesTargetSetCount`とは
 * 意図的な重複。
 */
function conditionContainsTargetSetCount(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "TARGET_SET_COUNT":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionContainsTargetSetCount(c));
    case "NOT":
      return conditionContainsTargetSetCount(condition.condition);
    default:
      return false;
  }
}

function stepsContainSetCondition(steps: readonly EffectStepDefinition[]): boolean {
  for (const step of steps) {
    // Issue #230: ACTIONのTARGET_SET_COUNTは`stepCondition`にしか置けない
    // （`targetCondition`はTRUE/AND/OR/NOT/TARGET_STATE/TARGET_HAS_MARKERの
    // みへスキーマ上制限される、`condition-definition.ts`の
    // `TARGET_CONDITION_KINDS`）。
    if (step.kind === "ACTION" && conditionContainsTargetSetCount(step.stepCondition)) {
      return true;
    }
    if (step.kind === "BRANCH" && conditionContainsTargetSetCount(step.condition)) {
      return true;
    }
    if (step.kind === "BRANCH") {
      if (stepsContainSetCondition(step.thenSteps) || stepsContainSetCondition(step.elseSteps)) {
        return true;
      }
    } else if (step.kind === "RANDOM_BRANCH") {
      if (step.branches.some((branch) => stepsContainSetCondition(branch.steps))) {
        return true;
      }
    } else if (step.kind === "REPEAT" && stepsContainSetCondition(step.steps)) {
      return true;
    }
  }
  return false;
}

/**
 * CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: `condition`のどこかに
 * `EVENT_PAYLOAD`が含まれるか（AND/OR/NOTを再帰的に見る）。`domain/catalog`は
 * `domain/battle`へ依存できない（module境界）ため、`skill-resolution-service.ts`の
 * `conditionReferencesEventPayload`とは意図的な重複。
 */
function conditionContainsEventPayload(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "EVENT_PAYLOAD":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionContainsEventPayload(c));
    case "NOT":
      return conditionContainsEventPayload(condition.condition);
    default:
      return false;
  }
}

/**
 * CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: `stepsContainSetCondition`
 * と同じ形。ACTIONの`EVENT_PAYLOAD`は`stepCondition`・`targetCondition`のどちらにも
 * 置ける（`condition-definition.ts`の`TARGET_CONDITION_KINDS`が許可する）ため、両方を見る。
 */
function stepsContainEventPayloadCondition(steps: readonly EffectStepDefinition[]): boolean {
  for (const step of steps) {
    if (
      step.kind === "ACTION" &&
      (conditionContainsEventPayload(step.stepCondition) ||
        conditionContainsEventPayload(step.targetCondition))
    ) {
      return true;
    }
    if (step.kind === "BRANCH" && conditionContainsEventPayload(step.condition)) {
      return true;
    }
    if (step.kind === "BRANCH") {
      if (
        stepsContainEventPayloadCondition(step.thenSteps) ||
        stepsContainEventPayloadCondition(step.elseSteps)
      ) {
        return true;
      }
    } else if (step.kind === "RANDOM_BRANCH") {
      if (step.branches.some((branch) => stepsContainEventPayloadCondition(branch.steps))) {
        return true;
      }
    } else if (step.kind === "REPEAT" && stepsContainEventPayloadCondition(step.steps)) {
      return true;
    }
  }
  return false;
}

/**
 * `condition`のどこかに`TARGET_STATE`/`TARGET_HAS_MARKER`が含まれるか
 * （AND/OR/NOTを再帰的に見る）。参照先の`TargetReference`は問わない —
 * PRレビュー[P2]再々々々指摘（Issue #227）: `effect-step-condition-evaluator.ts`の
 * `evaluateEffectStepCondition`は、`TARGET_SET_COUNT`単独経路
 * （`targetContext: undefined`）で呼ばれる際、参照先が`step.target`と一致
 * するかどうかに関わらず`TARGET_STATE`/`TARGET_HAS_MARKER`に到達した時点で
 * 例外を投げる（`EffectStepTargetContext`が無ければ評価できないため）。
 * `step.target`と一致する参照だけを拒否対象にしていた前回の実装は、
 * `SELF`など別の参照との組み合わせ（Catalog上は許可、実行時は例外）という
 * preflightと実行時の不一致を残していた。
 */
function conditionContainsTargetStateOrMarker(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionContainsTargetStateOrMarker(c));
    case "NOT":
      return conditionContainsTargetStateOrMarker(condition.condition);
    default:
      return false;
  }
}

/**
 * PRレビュー[P2]再々々指摘・再々々々指摘（Issue #227）。Issue #230で
 * `ACTION`は対象外になった: `stepCondition`/`targetCondition`という独立した
 * フィールドへ分離済みで、`stepCondition`は`TARGET_STATE`/
 * `TARGET_HAS_MARKER`を、`targetCondition`は`TARGET_SET_COUNT`をスキーマ上
 * 受理しない（`condition-definition.ts`の`STEP_CONDITION_KINDS`/
 * `TARGET_CONDITION_KINDS`、`effect-sequence.ts`の`createEffectStepDefinition`）
 * ため、この2種を同じconditionツリーへ混在させること自体が構造的に不可能
 * になった。`BRANCH`は`target`を持たず単一の`condition`が常にstep-wideの
 * ままであり、かつ`resolveBranchStep`（`effect-action-group-resolver.ts`）は
 * 今も`targetContext: undefined`で評価するため、`TARGET_STATE`/
 * `TARGET_HAS_MARKER`と`TARGET_SET_COUNT`の混在は変わらず拒否する
 * （元の理由: 量化の位置に依存して結果が変わり得るだけでなく、後者の場合でも
 * 評価器が対象コンテキストを持たず例外になる）。
 */
function collectMixedStepTargetSetConditionPaths(
  steps: readonly EffectStepDefinition[],
  path: string,
): readonly string[] {
  const paths: string[] = [];
  steps.forEach((step, index) => {
    const stepPath = `${path}[${index}]`;
    if (
      step.kind === "BRANCH" &&
      conditionContainsTargetStateOrMarker(step.condition) &&
      conditionContainsTargetSetCount(step.condition)
    ) {
      paths.push(`${stepPath}.condition`);
    }
    if (step.kind === "BRANCH") {
      paths.push(
        ...collectMixedStepTargetSetConditionPaths(step.thenSteps, `${stepPath}.thenSteps`),
        ...collectMixedStepTargetSetConditionPaths(step.elseSteps, `${stepPath}.elseSteps`),
      );
    } else if (step.kind === "RANDOM_BRANCH") {
      step.branches.forEach((branch, branchIndex) => {
        paths.push(
          ...collectMixedStepTargetSetConditionPaths(
            branch.steps,
            `${stepPath}.branches[${branchIndex}].steps`,
          ),
        );
      });
    } else if (step.kind === "REPEAT") {
      paths.push(...collectMixedStepTargetSetConditionPaths(step.steps, `${stepPath}.steps`));
    }
  });
  return paths;
}

/**
 * PRレビュー[P1]（Issue #230）: `resolveBranchStep`（`effect-action-group-resolver.ts`）は
 * `EffectStepTargetContext`を持たないため、BRANCHの`condition`に含まれる
 * `TARGET_STATE`/`TARGET_HAS_MARKER`は、参照する`TargetReference`が高々1体に
 * しか解決されない場合に限り、その1体（0体ならfalse）を直接評価する
 * （`effect-step-condition-evaluator.ts`の`evaluateEffectStepCondition`、
 * `resolveTargetSet`経由の分岐）。量化規則（EXISTS/ALL等）を発明せずに済む
 * 範囲へ意図的に限定しているため、それ以外の参照はCatalogロード時点で拒否する。
 * `SELF`/`TRIGGER_SOURCE`は常に1体、`BINDING`は宣言元の`selector`が
 * 高々1体しか解決しないことを`selectorGuaranteesAtMostOneUnit`で保証する場合
 * だけ許可する。`TRIGGER_TARGET`（`triggerTargetUnitIds`は複数ありうる）と
 * `LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`（AOEの直前結果を含みうる）は
 * 保証できないため拒否する。
 */
function targetReferenceIsSingleUnit(
  reference: TargetReference,
  bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition>,
): boolean {
  switch (reference.kind) {
    case "SELF":
    case "TRIGGER_SOURCE":
      return true;
    case "TRIGGER_TARGET":
    case "LAST_ACTION_TARGETS":
    case "LAST_DAMAGED_TARGETS":
      return false;
    case "BINDING": {
      if (reference.targetBindingId === undefined) {
        return false;
      }
      const selector = bindingSelectors.get(reference.targetBindingId);
      return selector !== undefined && selectorGuaranteesAtMostOneUnit(selector);
    }
  }
}

/**
 * PRレビュー[P2]再指摘（Issue #230）: `TargetSelectorDefinition`自身が高々1体
 * しか解決しないことを保証できるかどうか（`resolveTargets`の実装 —
 * `target-selection-policy.ts` — に基づく）。`kind: SELF`は常に`actor`
 * 1体、`kind: TRIGGER_SOURCE`は常に`triggerContext.triggerSourceUnitId`の
 * 高々1体（`resolveTriggerPool`）、`kind: SELECT`は`count: 1`の場合だけ
 * 高々1体（`count`は`SELECT`にしか付けられない）。`filters`/`area`は候補を
 * 絞り込むだけで増やさないため、この3ケース以外では保証しない —
 * `kind: TRIGGER_TARGET`は`triggerTargetUnitIds`が複数ありうるため不可、
 * `kind: BINDING_DERIVED`は`count`を持てず`area`（例:
 * `ADJACENT_ORTHOGONAL`は最大4体）で絞り込んだ0〜N体になりうるため不可。
 * `resolveTargets`は主selectorの候補が0件のときだけ`fallback`（独立した
 * `TargetSelectorDefinition`）へ切り替えるため（R-TGT-09 #7）、実際に解決
 * されうる集合は主selectorの結果と`fallback`の結果の和ではなく「どちらか
 * 一方」だが、値を見ずに静的検証する以上はどちらの経路を通っても高々1体で
 * あることを再帰的に保証する必要がある。
 */
function selectorGuaranteesAtMostOneUnit(selector: TargetSelectorDefinition): boolean {
  const ownSelectionGuaranteesAtMostOne =
    selector.kind === "SELF" ||
    selector.kind === "TRIGGER_SOURCE" ||
    (selector.kind === "SELECT" && selector.count === 1);
  if (!ownSelectionGuaranteesAtMostOne) {
    return false;
  }
  return selector.fallback === undefined || selectorGuaranteesAtMostOneUnit(selector.fallback);
}

function collectTargetStateOrMarkerReferences(
  condition: ConditionDefinition,
  path: string,
): readonly { readonly reference: TargetReference; readonly path: string }[] {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
      return [{ reference: condition.target, path }];
    case "AND":
    case "OR":
      return condition.conditions.flatMap((c, i) =>
        collectTargetStateOrMarkerReferences(c, `${path}.conditions[${i}]`),
      );
    case "NOT":
      return collectTargetStateOrMarkerReferences(condition.condition, `${path}.condition`);
    default:
      return [];
  }
}

function collectBranchTargetStateUnboundedReferencePaths(
  steps: readonly EffectStepDefinition[],
  path: string,
  bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition>,
): readonly string[] {
  const paths: string[] = [];
  steps.forEach((step, index) => {
    const stepPath = `${path}[${index}]`;
    if (step.kind === "BRANCH") {
      for (const { reference, path: refPath } of collectTargetStateOrMarkerReferences(
        step.condition,
        `${stepPath}.condition`,
      )) {
        if (!targetReferenceIsSingleUnit(reference, bindingSelectors)) {
          paths.push(refPath);
        }
      }
      paths.push(
        ...collectBranchTargetStateUnboundedReferencePaths(
          step.thenSteps,
          `${stepPath}.thenSteps`,
          bindingSelectors,
        ),
        ...collectBranchTargetStateUnboundedReferencePaths(
          step.elseSteps,
          `${stepPath}.elseSteps`,
          bindingSelectors,
        ),
      );
    } else if (step.kind === "RANDOM_BRANCH") {
      step.branches.forEach((branch, branchIndex) => {
        paths.push(
          ...collectBranchTargetStateUnboundedReferencePaths(
            branch.steps,
            `${stepPath}.branches[${branchIndex}].steps`,
            bindingSelectors,
          ),
        );
      });
    } else if (step.kind === "REPEAT") {
      paths.push(
        ...collectBranchTargetStateUnboundedReferencePaths(
          step.steps,
          `${stepPath}.steps`,
          bindingSelectors,
        ),
      );
    }
  });
  return paths;
}

function validateBranchTargetStateUnboundedReference(
  sequence: EffectSequence,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  const bindingSelectors = new Map<string, TargetSelectorDefinition>(
    sequence.targetBindings.map((binding) => [binding.targetBindingId, binding.selector]),
  );
  for (const path of collectBranchTargetStateUnboundedReferencePaths(
    sequence.steps,
    "steps",
    bindingSelectors,
  )) {
    violations.push({
      targetId: ownerId,
      rule: "BRANCH_TARGET_STATE_UNBOUNDED_REFERENCE",
      message: `${path}: BRANCH's condition evaluates TARGET_STATE/TARGET_HAS_MARKER against a TargetReference that is not guaranteed to resolve to at most one unit (only SELF, TRIGGER_SOURCE, or a BINDING whose selector has kind SELECT and count 1 are supported — BRANCH has no per-target evaluation context to quantify over multiple units, Issue #230 PRレビュー[P1])`,
    });
  }
}

function validateMixedStepTargetSetCondition(
  steps: readonly EffectStepDefinition[],
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  for (const path of collectMixedStepTargetSetConditionPaths(steps, "steps")) {
    violations.push({
      targetId: ownerId,
      rule: "MIXED_STEP_TARGET_SET_CONDITION",
      message: `${path} combines TARGET_SET_COUNT with a TARGET_STATE/TARGET_HAS_MARKER (regardless of which TargetReference it references) — per-target and step-wide condition scopes cannot be mixed in the same condition tree (RES-004集合条件, Issue #227)`,
    });
  }
}

/** R-SKL-08: conditionのどこかに`LAST_RESULT`が含まれるか（AND/OR/NOTを再帰的に見る）。 */
function conditionReferencesLastResult(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "LAST_RESULT":
      return true;
    case "AND":
    case "OR":
      return condition.conditions.some((c) => conditionReferencesLastResult(c));
    case "NOT":
      return conditionReferencesLastResult(condition.condition);
    default:
      return false;
  }
}

/**
 * Issue #217設計方針E: `LAST_RESULT`/`LAST_ACTION_TARGETS`/`LAST_DAMAGED_TARGETS`
 * が、到達しうる全経路で必ず先行結果を持つかを、Catalog構造だけから検証する
 * （実行時値・条件評価・乱数を一切使わない静的解析）。`definitelyAssigned`は
 * 「この時点までに、必ず1つ以上のEffectAction結果が確定している」を表す
 * boolean latticeで、`false`→`true`にしか遷移しない（一度trueになった経路は
 * 二度と後退しない）。
 *
 * 合流規則（design point Eの最小規則）:
 * - `ACTION`: conditionが常にtrue（`TRUE`固定）の場合だけ、このstep自身が
 *   必ず結果を残す（false条件へ倒れうる場合や、対象0件になりうる場合も
 *   R-SKL-08よりSKIPPED結果を残すが、conditionが常にtrueとは限らない場合は
 *   「このstep自体がconditionで丸ごとskipされる経路」があるため、それだけを
 *   根拠にdefinitely-definedへ昇格しない）。
 * - `BRANCH`: then/else双方の出口で定義済みの場合だけ、合流後を
 *   definitely-definedとする。
 * - `RANDOM_BRANCH.WEIGHTED_ONE`: 到達可能（`weight > 0`）な全branchの出口で
 *   定義済みの場合だけ、合流後をdefinitely-definedとする。
 * - `RANDOM_BRANCH.INDEPENDENT`: 0 branch成立の経路が常に存在するため、
 *   branch内部だけを根拠に合流後をdefinitely-definedとしない
 *   （入力時点で既にtrueならtrueのまま）。
 * - `REPEAT`: `count >= 1`（Catalogが保証する）ため、bodyを1回歩いた結果を
 *   そのまま採用する（同じ状態からの2回目以降の歩行は、状態が変化しない
 *   純関数のため恒等的に同じ結果になる）。
 */
function walkLastResultDataFlowStep(
  step: EffectStepDefinition,
  path: string,
  definitelyAssigned: boolean,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): boolean {
  switch (step.kind) {
    case "ACTION": {
      // Issue #230: `LAST_RESULT`/`TARGET_SET_COUNT`は`stepCondition`にしか
      // 置けない。`targetCondition`は常にこのstep自身の`target`だけを参照する
      // （`assertTargetConditionReferencesOwnTarget`が保証する）ため、
      // `step.target.kind`のチェックと重複する内容にしかならず、別途走査
      // する必要がない。
      if (!definitelyAssigned) {
        if (conditionReferencesLastResult(step.stepCondition)) {
          violations.push({
            targetId: ownerId,
            rule: "MISSING_PRECEDING_RESULT",
            message: `${path}.stepCondition references kind "LAST_RESULT" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
          });
        }
        if (
          step.target.kind === "LAST_ACTION_TARGETS" ||
          step.target.kind === "LAST_DAMAGED_TARGETS"
        ) {
          violations.push({
            targetId: ownerId,
            rule: "MISSING_PRECEDING_RESULT",
            message: `${path}.target references kind "${step.target.kind}" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
          });
        }
        for (const reference of collectConditionTargetReferences(step.stepCondition)) {
          if (LAST_RESULT_TARGET_KINDS.has(reference.kind)) {
            violations.push({
              targetId: ownerId,
              rule: "MISSING_PRECEDING_RESULT",
              message: `${path}.stepCondition's TargetReference references kind "${reference.kind}" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
            });
          }
        }
      }
      return definitelyAssigned || step.stepCondition.kind === "TRUE";
    }
    case "BRANCH": {
      if (!definitelyAssigned) {
        if (conditionReferencesLastResult(step.condition)) {
          violations.push({
            targetId: ownerId,
            rule: "MISSING_PRECEDING_RESULT",
            message: `${path}.condition references kind "LAST_RESULT" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
          });
        }
        for (const reference of collectConditionTargetReferences(step.condition)) {
          if (LAST_RESULT_TARGET_KINDS.has(reference.kind)) {
            violations.push({
              targetId: ownerId,
              rule: "MISSING_PRECEDING_RESULT",
              message: `${path}.condition's TargetReference references kind "${reference.kind}" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
            });
          }
        }
      }
      const assignedThen = walkLastResultDataFlowList(
        step.thenSteps,
        `${path}.thenSteps`,
        definitelyAssigned,
        ownerId,
        violations,
      );
      const assignedElse = walkLastResultDataFlowList(
        step.elseSteps,
        `${path}.elseSteps`,
        definitelyAssigned,
        ownerId,
        violations,
      );
      return assignedThen && assignedElse;
    }
    case "RANDOM_BRANCH": {
      if (step.mode === "WEIGHTED_ONE") {
        const reachableResults = step.branches
          .map((branch, index) =>
            (branch.weight ?? 0) > 0
              ? walkLastResultDataFlowList(
                  branch.steps,
                  `${path}.branches[${index}].steps`,
                  definitelyAssigned,
                  ownerId,
                  violations,
                )
              : undefined,
          )
          .filter((assigned): assigned is boolean => assigned !== undefined);
        return reachableResults.length > 0
          ? reachableResults.every((assigned) => assigned)
          : definitelyAssigned;
      }
      // INDEPENDENT: 0 branch成立の経路が常に存在するため、branch内部だけを
      // 根拠に合流後をdefinitely-definedへ昇格しない。violation収集のためだけに
      // 各branchを歩く。
      step.branches.forEach((branch, index) => {
        walkLastResultDataFlowList(
          branch.steps,
          `${path}.branches[${index}].steps`,
          definitelyAssigned,
          ownerId,
          violations,
        );
      });
      return definitelyAssigned;
    }
    case "REPEAT":
      return walkLastResultDataFlowList(
        step.steps,
        `${path}.steps`,
        definitelyAssigned,
        ownerId,
        violations,
      );
  }
}

function walkLastResultDataFlowList(
  steps: readonly EffectStepDefinition[],
  path: string,
  definitelyAssigned: boolean,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): boolean {
  let assigned = definitelyAssigned;
  steps.forEach((step, index) => {
    assigned = walkLastResultDataFlowStep(step, `${path}[${index}]`, assigned, ownerId, violations);
  });
  return assigned;
}

function validateLastResultDataFlow(
  steps: readonly EffectStepDefinition[],
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  walkLastResultDataFlowList(steps, "steps", false, ownerId, violations);
}

function sequenceRequiresCapability(
  sequence: EffectSequence,
  capabilityId: RuntimeStructuralCapabilityId,
): boolean {
  switch (capabilityId) {
    case "CAP_RESOLUTION_BRANCH_REPEAT":
      return stepsContainTargetReferenceKinds(sequence.steps, LAST_RESULT_TARGET_KINDS);
    case "CAP_RANDOM_BRANCH":
      return containsStepKind(sequence.steps, RANDOM_BRANCH_STEP_KINDS);
    case "CAP_TARGET_FILTER_ORDER":
      return sequence.targetBindings.some(({ selector }) =>
        selectorTreeSome(
          selector,
          (candidate) =>
            candidate.filters.length > 0 ||
            candidate.order.length !== 1 ||
            candidate.order[0] !== "DEFAULT",
        ),
      );
    case "CAP_TARGET_DERIVED_AREA":
      return sequence.targetBindings.some(({ selector }) =>
        selectorTreeSome(
          selector,
          (candidate) => candidate.kind === "BINDING_DERIVED" || candidate.area !== undefined,
        ),
      );
    case "CAP_TARGET_BINDING_FALLBACK":
      return sequence.targetBindings.some(({ selector }) => selector.fallback !== undefined);
    case "CAP_EFFECT_STEP_CONDITION":
      return stepsContainNonTrueCondition(sequence.steps);
    case "CAP_EFFECT_STEP_SET_CONDITION":
      return stepsContainSetCondition(sequence.steps);
    case "CAP_TRIGGER_PAYLOAD_IN_RESOLUTION":
      return stepsContainEventPayloadCondition(sequence.steps);
    case "CAP_TRIGGER_CONTEXT":
      return (
        sequence.targetBindings.some(({ selector }) =>
          selectorTreeSome(
            selector,
            (candidate) =>
              TRIGGER_CONTEXT_TARGET_KINDS.has(candidate.kind) ||
              (candidate.base !== undefined &&
                TRIGGER_CONTEXT_TARGET_KINDS.has(candidate.base.kind)),
          ),
        ) || stepsContainTargetReferenceKinds(sequence.steps, TRIGGER_CONTEXT_TARGET_KINDS)
      );
    default:
      return false;
  }
}

function requireRuntimeCapability(
  targetId: string,
  requiredCapabilities: readonly CapabilityId[],
  capabilityId: RuntimeStructuralCapabilityId,
  reason: string,
  violations: CatalogIntegrityViolation[],
): void {
  if (!requiredCapabilities.some((id) => id === capabilityId)) {
    violations.push({
      targetId,
      rule: "MISSING_REQUIRED_CAPABILITY",
      message: `${reason} must declare "${capabilityId}" in requiredCapabilities`,
    });
  }
}

function validateRuntimeCapabilityDeclarations(
  targetId: string,
  requiredCapabilities: readonly CapabilityId[],
  sequences: readonly EffectSequence[],
  triggers: readonly TriggerDefinition[],
  activationCondition: ConditionDefinition | undefined,
  skillType: SkillDefinition["skillType"] | undefined,
  violations: CatalogIntegrityViolation[],
): void {
  if (
    (sequences.some((sequence) => containsStepKind(sequence.steps, BRANCH_REPEAT_STEP_KINDS)) ||
      sequences.some((sequence) =>
        sequenceRequiresCapability(sequence, "CAP_RESOLUTION_BRANCH_REPEAT"),
      )) &&
    !requiredCapabilities.some((id) => id === "CAP_RESOLUTION_BRANCH_REPEAT")
  ) {
    violations.push({
      targetId,
      rule: "MISSING_REQUIRED_CAPABILITY",
      message:
        'BRANCH/REPEAT EffectStep or LAST_ACTION_TARGETS/LAST_DAMAGED_TARGETS reference must declare "CAP_RESOLUTION_BRANCH_REPEAT" in requiredCapabilities',
    });
  }
  if (sequences.some((sequence) => sequenceRequiresCapability(sequence, "CAP_RANDOM_BRANCH"))) {
    requireRuntimeCapability(
      targetId,
      requiredCapabilities,
      "CAP_RANDOM_BRANCH",
      "RANDOM_BRANCH EffectStep",
      violations,
    );
  }
  if (activationCondition !== undefined && activationCondition.kind !== "TRUE") {
    const capabilityId =
      skillType === "PS" ? "CAP_PASSIVE_ACTIVATION_CONDITION" : "CAP_ACTION_ACTIVATION_CONDITION";
    requireRuntimeCapability(
      targetId,
      requiredCapabilities,
      capabilityId,
      `${skillType ?? "Unknown"} Skill non-TRUE activationCondition`,
      violations,
    );
  }
  if (
    (triggers.some((trigger) => TRIGGER_CONTEXT_EVENT_TYPES.has(trigger.eventType)) ||
      sequences.some((sequence) => sequenceRequiresCapability(sequence, "CAP_TRIGGER_CONTEXT"))) &&
    !requiredCapabilities.some((id) => id === "CAP_TRIGGER_CONTEXT")
  ) {
    violations.push({
      targetId,
      rule: "MISSING_REQUIRED_CAPABILITY",
      message:
        'runtime-owned trigger event or TRIGGER_SOURCE/TRIGGER_TARGET reference must declare "CAP_TRIGGER_CONTEXT" in requiredCapabilities',
    });
  }
  if (
    (skillType === "AS" || skillType === "EX") &&
    sequences.some((sequence) =>
      sequenceRequiresCapability(sequence, "CAP_TRIGGER_PAYLOAD_IN_RESOLUTION"),
    )
  ) {
    // CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D、PRレビュー[P2]）:
    // `EVENT_PAYLOAD`はPS発動を引き起こしたトリガーイベントのpayloadだけを
    // 参照できる（`PassiveActivationRuntime`が`EffectActionGroupContext.
    // triggerEventPayload`へ供給する）。AS/EX active skillの解決
    // （`action-skill-use-resolver.ts`の`resolveSkillUse`）はこのフィールドを
    // 一切populateしないため、schemaは受理してしまってもCatalogロード時点で
    // 明確に拒否する — 実行時まで待つと`evaluateEffectStepCondition`が
    // `DomainValidationError`を投げ、行動選択後に解決が途中で失敗してしまう。
    violations.push({
      targetId,
      rule: "EVENT_PAYLOAD_REQUIRES_PS_SKILL",
      message: `EVENT_PAYLOAD condition requires a PS Skill (the triggering event's payload only exists during a passive activation) — "${targetId}" is skillType "${skillType}"`,
    });
  }
  for (const [capabilityId, reason] of [
    ["CAP_TARGET_FILTER_ORDER", "Target selector filter/non-default order"],
    ["CAP_TARGET_DERIVED_AREA", "BINDING_DERIVED/area target selector"],
    ["CAP_TARGET_BINDING_FALLBACK", "Target selector fallback"],
    ["CAP_EFFECT_STEP_CONDITION", "EffectStep non-TRUE condition"],
    ["CAP_EFFECT_STEP_SET_CONDITION", "EffectStep TARGET_SET_COUNT condition"],
    ["CAP_TRIGGER_PAYLOAD_IN_RESOLUTION", "EffectStep EVENT_PAYLOAD condition"],
  ] as const) {
    if (sequences.some((sequence) => sequenceRequiresCapability(sequence, capabilityId))) {
      requireRuntimeCapability(targetId, requiredCapabilities, capabilityId, reason, violations);
    }
  }
}

function validateTrigger(
  trigger: TriggerDefinition,
  targetId: string,
  violations: CatalogIntegrityViolation[],
): void {
  const documentedCategory = EVENT_TYPE_CATEGORIES[trigger.eventType];
  if (documentedCategory === undefined) {
    const isDiagnosticOnly = DIAGNOSTIC_ONLY_EVENT_TYPES.has(trigger.eventType);
    violations.push({
      targetId,
      rule: "UNKNOWN_EVENT_TYPE",
      message: isDiagnosticOnly
        ? `references DIAGNOSTIC-only eventType "${trigger.eventType}", which cannot be a Trigger target`
        : `references unknown eventType "${trigger.eventType}"`,
    });
    return;
  }
  if (documentedCategory !== trigger.category) {
    violations.push({
      targetId,
      rule: "EVENT_CATEGORY_MISMATCH",
      message: `eventType "${trigger.eventType}" is documented as category "${documentedCategory}", but declares category "${trigger.category}"`,
    });
  }
}

function checkRequiredCapabilities(
  requiredCapabilities: readonly CapabilityId[],
  targetId: string,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  for (const capabilityId of requiredCapabilities) {
    const capability = capabilities.get(capabilityId);
    if (capability === undefined) {
      violations.push({
        targetId,
        rule: "UNKNOWN_CAPABILITY",
        message: `requiredCapabilities references undefined capability "${capabilityId}"`,
      });
    } else if (capability.schemaStatus !== "SUPPORTED") {
      violations.push({
        targetId,
        rule: "UNSUPPORTED_SCHEMA_CAPABILITY",
        message: `requiredCapabilities references capability "${capabilityId}" whose schemaStatus is "${capability.schemaStatus}"`,
      });
    }
  }
}

function validateCapabilityVerification(
  capability: CapabilityDefinition,
  units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  if (capability.runtimeStatus !== "IMPLEMENTED") {
    return;
  }

  for (const definitionId of capability.verification.productionDefinitionIds) {
    const definition =
      units.get(definitionId as UnitDefinitionId) ??
      skills.get(definitionId as SkillDefinitionId) ??
      effectActions.get(definitionId as EffectActionDefinitionId) ??
      memories.get(definitionId as MemoryDefinitionId);
    if (definition === undefined) {
      violations.push({
        targetId: capability.capabilityId,
        rule: "INVALID_CAPABILITY_VERIFICATION",
        message: `verification references undefined production definition "${definitionId}"`,
      });
      continue;
    }
    if (!definition.requiredCapabilities.includes(capability.capabilityId)) {
      violations.push({
        targetId: capability.capabilityId,
        rule: "INVALID_CAPABILITY_VERIFICATION",
        message: `verification definition "${definitionId}" does not declare capability "${capability.capabilityId}"`,
      });
    }
  }
}

function checkNoDuplicateSkillReferences(
  skillIds: readonly SkillDefinitionId[],
  listName: string,
  unitId: string,
  violations: CatalogIntegrityViolation[],
): void {
  const seen = new Set<SkillDefinitionId>();
  for (const id of skillIds) {
    if (seen.has(id)) {
      violations.push({
        targetId: unitId,
        rule: "DUPLICATE_SKILL_REFERENCE",
        message: `${listName} lists "${id}" more than once, making definition order ambiguous`,
      });
    }
    seen.add(id);
  }
}

function validateSkillReference(
  skillId: SkillDefinitionId,
  expectedSkillType: SkillDefinition["skillType"],
  unitId: string,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  violations: CatalogIntegrityViolation[],
): SkillDefinition | undefined {
  const skill = skills.get(skillId);
  if (skill === undefined) {
    violations.push({
      targetId: unitId,
      rule: "DANGLING_REFERENCE",
      message: `references undefined SkillDefinition "${skillId}"`,
    });
    return undefined;
  }
  if (skill.skillType !== expectedSkillType) {
    violations.push({
      targetId: unitId,
      rule: "TYPE_MISMATCH",
      message: `references Skill "${skillId}" with skillType "${skill.skillType}", expected "${expectedSkillType}"`,
    });
    return undefined;
  }
  return skill;
}

function validateUnit(
  unit: UnitDefinition,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  checkNoDuplicateSkillReferences(
    unit.activeSkillDefinitionIds,
    "activeSkillDefinitionIds",
    unit.unitDefinitionId,
    violations,
  );
  checkNoDuplicateSkillReferences(
    unit.passiveSkillDefinitionIds,
    "passiveSkillDefinitionIds",
    unit.unitDefinitionId,
    violations,
  );

  for (const skillId of unit.activeSkillDefinitionIds) {
    validateSkillReference(skillId, "AS", unit.unitDefinitionId, skills, violations);
  }
  for (const skillId of unit.passiveSkillDefinitionIds) {
    validateSkillReference(skillId, "PS", unit.unitDefinitionId, skills, violations);
  }
  const exSkill = validateSkillReference(
    unit.extraSkillDefinitionId,
    "EX",
    unit.unitDefinitionId,
    skills,
    violations,
  );
  if (exSkill !== undefined && exSkill.cost.amount !== unit.extraGaugeMaximum) {
    violations.push({
      targetId: unit.unitDefinitionId,
      rule: "EX_COST_MISMATCH",
      message: `EX skill "${exSkill.skillDefinitionId}" cost.amount (${exSkill.cost.amount}) does not match extraGaugeMaximum (${unit.extraGaugeMaximum})`,
    });
  }

  checkRequiredCapabilities(
    unit.requiredCapabilities,
    unit.unitDefinitionId,
    capabilities,
    violations,
  );

  const ownedSkillIds = new Set<SkillDefinitionId>([
    ...unit.activeSkillDefinitionIds,
    ...unit.passiveSkillDefinitionIds,
    unit.extraSkillDefinitionId,
  ]);
  checkCooldownManipulationOwnership(unit, ownedSkillIds, skills, effectActions, violations);
}

function validateSkill(
  skill: SkillDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  validateEffectActionReferences(
    skill.resolution.steps,
    effectActions,
    skill.skillDefinitionId,
    violations,
  );
  if (skill.resolution.kind === "CHARGE") {
    validateEffectActionReferences(
      skill.resolution.chargeRelease.steps,
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  const sequences =
    skill.resolution.kind === "CHARGE"
      ? [skill.resolution, skill.resolution.chargeRelease]
      : [skill.resolution];
  for (const sequence of sequences) {
    validateLastResultDataFlow(sequence.steps, skill.skillDefinitionId, violations);
    validateMixedStepTargetSetCondition(sequence.steps, skill.skillDefinitionId, violations);
    validateBranchTargetStateUnboundedReference(sequence, skill.skillDefinitionId, violations);
  }
  const runtimeTriggers = [
    ...skill.triggers,
    ...skill.counterUpdates.map((counterUpdate) => counterUpdate.trigger),
    ...sequences.flatMap((sequence) =>
      (sequence.counterUpdates ?? []).map((counterUpdate) => counterUpdate.trigger),
    ),
  ];
  if (skill.counterUpdates.length > 0) {
    requireRuntimeCapability(
      skill.skillDefinitionId,
      skill.requiredCapabilities,
      "CAP_SKILL_RUNTIME_COUNTER",
      "Skill counterUpdates",
      violations,
    );
  }
  if (sequences.some((sequence) => (sequence.counterUpdates ?? []).length > 0)) {
    requireRuntimeCapability(
      skill.skillDefinitionId,
      skill.requiredCapabilities,
      "CAP_EFFECT_SEQUENCE_RUNTIME_COUNTER",
      "EffectSequence counterUpdates",
      violations,
    );
  }
  validateRuntimeCapabilityDeclarations(
    skill.skillDefinitionId,
    skill.requiredCapabilities,
    sequences,
    runtimeTriggers,
    skill.activationCondition,
    skill.skillType,
    violations,
  );
  for (const trigger of skill.triggers) {
    validateTrigger(trigger, skill.skillDefinitionId, violations);
  }
  for (const counterUpdate of skill.counterUpdates) {
    validateTrigger(counterUpdate.trigger, skill.skillDefinitionId, violations);
  }
  checkRequiredCapabilities(
    skill.requiredCapabilities,
    skill.skillDefinitionId,
    capabilities,
    violations,
  );
}

function validateEffectAction(
  effectAction: EffectActionDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  if (effectAction.kind === "EFFECT_IMMUNITY" || effectAction.kind === "REMOVE_EFFECTS") {
    for (const referencedId of effectAction.payload.effectActionDefinitionIds ?? []) {
      if (!effectActions.has(referencedId)) {
        violations.push({
          targetId: effectAction.effectActionDefinitionId,
          rule: "DANGLING_REFERENCE",
          message: `${effectAction.kind} payload.effectActionDefinitionIds references undefined EffectActionDefinition "${referencedId}"`,
        });
      }
    }
  }
  // M7-001（Issue #181、再々レビュー[P2]）: REMOVE_EFFECTSのSHIELD/SUBUNITカテゴリは
  // シールド/サブユニットの実行時状態が未モデル化（`CAP_SHIELD`=DMG-004、
  // `CAP_SUBUNIT`=DMG-005、いずれも`PLANNED`、#242）。`COOLDOWN_MANIPULATION`/
  // `CAP_COOLDOWN_MANIPULATION`と同じ「宣言漏れ自体を拒否する」パターンで、対応する
  // Capabilityの宣言を必須にする。これによりCatalog自体は正しく宣言されていれば
  // ロードでき（Capabilityが`PLANNED`のままでも）、実際の拒否は選択時の
  // `SimulationPreflightValidator`（`findUnimplementedCapabilities`）が
  // `UNSUPPORTED_RULE`として行う — Catalog全体のロード失敗にはしない。
  if (effectAction.kind === "REMOVE_EFFECTS") {
    // `14_Catalog定義スキーマ.md`「REMOVE_EFFECTSを使うEffectActionDefinitionは
    // requiredCapabilitiesにCAP_REMOVE_EFFECTSを含めること」（再々々レビュー[P2]）:
    // categoriesの内容によらず、REMOVE_EFFECTS自体の宣言を無条件で必須にする。
    // SHIELD/SUBUNIT固有のCAP_SHIELD/CAP_SUBUNIT宣言はこれとは独立な追加要件
    // （両方とも要求されうる）。
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_REMOVE_EFFECTS")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: 'REMOVE_EFFECTS must declare "CAP_REMOVE_EFFECTS" in requiredCapabilities',
      });
    }
    if (
      effectAction.payload.categories.includes("SHIELD") &&
      !effectAction.requiredCapabilities.some((id) => id === "CAP_SHIELD")
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'REMOVE_EFFECTS with the "SHIELD" category must declare "CAP_SHIELD" in requiredCapabilities',
      });
    }
    if (
      effectAction.payload.categories.includes("SUBUNIT") &&
      !effectAction.requiredCapabilities.some((id) => id === "CAP_SUBUNIT")
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'REMOVE_EFFECTS with the "SUBUNIT" category must declare "CAP_SUBUNIT" in requiredCapabilities',
      });
    }
  }
  // M7-001B（Issue #243、EFFECT_IMMUNITY_STATUS_GRANULARITY）: `statusKinds`は
  // `CAP_SPECIFIC_IMMUNITY`（個別状態異常無効）そのものの機能なので、使用時は
  // `CAP_REMOVE_EFFECTS`と同じ「宣言漏れ自体を拒否する」パターンで宣言を必須に
  // する。`statusKinds`を使わない（STATUSカテゴリ全体を対象にする）既存の
  // `EFFECT_IMMUNITY`はこの新しいCapabilityを要求しない。
  if (effectAction.kind === "EFFECT_IMMUNITY") {
    if (
      effectAction.payload.statusKinds !== undefined &&
      !effectAction.requiredCapabilities.some((id) => id === "CAP_SPECIFIC_IMMUNITY")
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'EFFECT_IMMUNITY with "statusKinds" must declare "CAP_SPECIFIC_IMMUNITY" in requiredCapabilities',
      });
    }
  }
  // Issue #129: COOLDOWN_MANIPULATIONの対象スキル存在チェック。所有者一致は
  // `checkCooldownManipulationOwnership`（Unit視点でのみ判定可能）が担う。
  if (effectAction.kind === "COOLDOWN_MANIPULATION") {
    if (!skills.has(effectAction.payload.targetSkillDefinitionId)) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "DANGLING_REFERENCE",
        message: `COOLDOWN_MANIPULATION payload.targetSkillDefinitionId references undefined SkillDefinition "${effectAction.payload.targetSkillDefinitionId}"`,
      });
    }
    // Issue #129レビュー[P2]: `14_Catalog定義スキーマ.md`は`CAP_COOLDOWN_MANIPULATION`を
    // requiredCapabilitiesへ含めることを必須としているが、`checkRequiredCapabilities`は
    // 列挙済みCapabilityの存在有無しか検証しないため、指定漏れ自体は別途検証する。
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_COOLDOWN_MANIPULATION")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: `COOLDOWN_MANIPULATION must declare "CAP_COOLDOWN_MANIPULATION" in requiredCapabilities`,
      });
    }
  }
  // PR #207再レビュー[P1]: EFF-001はAppliedEffectレジストリ・EffectApplied・
  // StateDeltaだけを実装し、CombatStat再計算（R-EFF-05/R-STA-02〜04、EFF-002の
  // スコープ）は行わない。`APPLY_STAT_MOD`をこの状態でresolverへ到達させると、
  // 効いていない補正を`EffectActionCompleted.resultKind: "APPLIED"`として
  // 成功扱いにしてしまう。production Catalogの全行へ`CAP_STAT_MOD`を後付けした
  // だけでは、宣言漏れの新規/カスタムCatalogがこの検証をすり抜けてしまうため、
  // `COOLDOWN_MANIPULATION`/`CAP_COOLDOWN_MANIPULATION`と同じ「宣言漏れ自体を
  // 拒否する」検証をkindレベルで強制する。
  if (effectAction.kind === "APPLY_STAT_MOD") {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_STAT_MOD")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: `APPLY_STAT_MOD must declare "CAP_STAT_MOD" in requiredCapabilities`,
      });
    }
  }
  // PRレビュー指摘[P2]（PR #254、Issue #185）で、`CAP_RESOURCE_MUTATION`
  // （ADD/SET/SET_TO_MAX）のIMPLEMENTED状態が未実装の`operation: DISTRIBUTE`
  // まで安全であるかのように誤読されないよう、DISTRIBUTE使用箇所には専用の
  // `CAP_RESOURCE_DISTRIBUTE`を必須宣言させた。M7-017（Issue #271）で
  // `CAP_RESOURCE_DISTRIBUTE`はIMPLEMENTEDになったが、宣言そのものは
  // `COOLDOWN_MANIPULATION`/`APPLY_STAT_MOD`（同じくIMPLEMENTED）と同じ
  // 「宣言漏れ自体を拒否する」パターンで引き続き強制する — 分配セマンティクスを
  // 使う定義がCatalog上で常に自己申告され、Capability台帳から追跡できる状態を保つ。
  if (effectAction.kind === "MODIFY_RESOURCE" && effectAction.payload.operation === "DISTRIBUTE") {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_RESOURCE_DISTRIBUTE")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'MODIFY_RESOURCE with operation "DISTRIBUTE" must declare "CAP_RESOURCE_DISTRIBUTE" in requiredCapabilities',
      });
    }
  }
  // RES-003A（Issue #257、G-10）: `SUM_DAMAGE_DEALT`/`SUM_DAMAGE_RECEIVED`
  // （EffectSequence実行中の累計）は`formula-evaluator.ts`の`DamageResultRegistry`
  // へ`SkillUseId`（=1回のEffectSequence解決）単位で配線済みで、
  // `CAP_SUM_DAMAGE_RESULT`は`IMPLEMENTED`になった。PR #256が「未配線の隔離」の
  // ために設けた`UNSUPPORTED_SUM_DAMAGE_RESULT`は役目を終えたので除去したが、
  // 宣言そのものは`COOLDOWN_MANIPULATION`/`CAP_COOLDOWN_MANIPULATION`
  // （同じく`IMPLEMENTED`）と同じ「宣言漏れ自体を拒否する」パターンで引き続き
  // 必須にする — `14_Catalog定義スキーマ.md`が宣言を必須と定めている一方、
  // `checkRequiredCapabilities`は列挙済みCapabilityの存在有無しか検証できず、
  // 宣言漏れ自体は素通ししてしまうため（`CAP_COOLDOWN_MANIPULATION`と同じ理由）。
  // 宣言はCapability→定義の追跡可能性そのものであり、将来`SUM_*`の対応範囲が
  // 狭まった場合に`SimulationPreflightValidator`が該当定義を隔離する足場にもなる。
  // なお`verification.productionDefinitionIds`は他のCapabilityと同じく代表証跡
  // であり（例: `CAP_CONTINUOUS_HEAL`はproduction 13件中1件のみ）、この検証が
  // 証跡一覧との一致を保証するわけではない。
  if (formulasOf(effectAction).some(referencesSumDamageResult)) {
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_SUM_DAMAGE_RESULT")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message:
          'a FormulaDefinition referencing "SUM_DAMAGE_DEALT"/"SUM_DAMAGE_RECEIVED" must declare "CAP_SUM_DAMAGE_RESULT" in requiredCapabilities',
      });
    }
  }
  // R-HEAL-03（M7-005、Issue #184）: `continuous-heal-service.ts`は
  // `timing: {eventType: "ActionStarted", targetSelector: "EFFECT_OWNER"}`
  // （production Catalogの継続回復13件がすべて使う唯一の組み合わせ）だけを
  // 発火させる。`timing`はスキーマ上任意の文字列を取れるため、他の組み合わせを
  // 指定した定義は`CAP_CONTINUOUS_HEAL`（IMPLEMENTED）を宣言していても
  // 「`EffectApplied`として成功するが一度も回復しない」silent partial
  // implementationになる。`APPLY_MARKER`の未対応Duration
  // （`UNSUPPORTED_MARKER_DURATION`）と同じく、Catalogロード時点で拒否する。
  if (effectAction.kind === "APPLY_CONTINUOUS_HEAL") {
    const timing = effectAction.payload.timing;
    if (timing.eventType !== "ActionStarted" || timing.targetSelector !== "EFFECT_OWNER") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_CONTINUOUS_HEAL_TIMING",
        message: `APPLY_CONTINUOUS_HEAL only implements timing {eventType: "ActionStarted", targetSelector: "EFFECT_OWNER"} (R-HEAL-03, M7-005), received {eventType: "${timing.eventType}", targetSelector: "${timing.targetSelector}"}`,
      });
    }
  }
  // R-HEAL-04（`M7-005-HEAL-LINK`、Issue #229）: 回復リンクの転送先は付与時点に
  // 解決して`AppliedEffect.healingLink`へ焼き込む。`heal-application-service.ts`は
  // 回復適用時にそのユニットIDしか参照しないため、付与時点で確定しない
  // `TargetReference`（`TRIGGER_*`/`BINDING`/`LAST_*`）は「`EffectApplied`として
  // 成功するが転送先が決まらない」silent partial implementationになる。
  // `APPLY_CONTINUOUS_HEAL`の未対応`timing`と同じくCatalogロード時点で拒否する。
  // 併せて`COOLDOWN_MANIPULATION`/`APPLY_STAT_MOD`と同じ「宣言漏れ自体を拒否する」
  // パターンで`CAP_HEALING_LINK`の宣言を必須にする。
  if (effectAction.kind === "APPLY_HEALING_LINK") {
    if (effectAction.payload.transferTo.kind !== "SELF") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_HEALING_LINK_TRANSFER_TARGET",
        message: `APPLY_HEALING_LINK only implements transferTo {kind: "SELF"} (R-HEAL-04, M7-005-HEAL-LINK), received {kind: "${effectAction.payload.transferTo.kind}"}`,
      });
    }
    if (!effectAction.requiredCapabilities.some((id) => id === "CAP_HEALING_LINK")) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "MISSING_REQUIRED_CAPABILITY",
        message: 'APPLY_HEALING_LINK must declare "CAP_HEALING_LINK" in requiredCapabilities',
      });
    }
  }
  // PR #210再レビュー[P2]: `marker-duration.ts`はACTION/TURN単位のDuration
  // 減算だけを実装する（`BATTLE`は本来減算不要のため対象外扱いで問題ない）。
  // `consumption`（消費条件）・`expiration`（特殊失効条件）・`HIT`/`SKILL_USE`
  // 単位の`timeLimit`はschema上`APPLY_MARKER`へ設定できてしまうが、実装が
  // 存在しないため、指定してもMarkerが消費・失効しないまま`CAP_MARKER`
  // （`IMPLEMENTED`）がpreflightを素通りさせてしまう。対応するまでCatalog
  // ロード時点で明示的に拒否する。
  if (effectAction.kind === "APPLY_MARKER") {
    const duration = effectAction.payload.duration;
    if (duration.consumption !== undefined) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message:
          "APPLY_MARKER.duration.consumption is not yet supported: Marker consumption (R-EFF-07 equivalent) is not implemented (marker-duration.ts)",
      });
    }
    if (duration.expiration !== undefined) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message:
          "APPLY_MARKER.duration.expiration is not yet supported: Marker special expiration conditions (R-EFF-08 equivalent) are not implemented",
      });
    }
    if (
      duration.timeLimit !== undefined &&
      duration.timeLimit.unit !== "ACTION" &&
      duration.timeLimit.unit !== "TURN" &&
      duration.timeLimit.unit !== "BATTLE"
    ) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message: `APPLY_MARKER.duration.timeLimit.unit "${duration.timeLimit.unit}" is not yet supported: only ACTION/TURN decrement and BATTLE (no decrement) are implemented (marker-duration.ts)`,
      });
    }
    // EFF-005/Issue #162: `AppliedEffect`スコープのRuntimeCounter更新
    // （`counterUpdates`）はschema上`APPLY_MARKER`へも設定できてしまうが、
    // `MarkerState`の期間機構自体（consumption/expiration/HIT・SKILL_USE単位
    // timeLimit）が上と同じ理由で未実装のため、counterUpdatesだけを宣言しても
    // 更新もexpiration評価も行われない。他のUNSUPPORTED_MARKER_DURATIONと
    // 同じくCatalogロード時点で明示的に拒否する。
    if (duration.counterUpdates !== undefined && duration.counterUpdates.length > 0) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_DURATION",
        message:
          "APPLY_MARKER.duration.counterUpdates is not yet supported: Marker RuntimeCounter (R-EFF-11 AppliedEffect scope) requires Marker expiration, which is not implemented",
      });
    }
  } else {
    const duration = durationOf(effectAction);
    if (
      duration !== undefined &&
      duration.counterUpdates !== undefined &&
      duration.counterUpdates.length > 0
    ) {
      requireRuntimeCapability(
        effectAction.effectActionDefinitionId,
        effectAction.requiredCapabilities,
        "CAP_EFFECT_RUNTIME_COUNTER",
        "EffectActionDefinition duration.counterUpdates",
        violations,
      );
    }
  }
  // R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020、Issue #279）: 付与者の
  // 戦闘不能による解除は`marker-source-defeat-service.ts`が`MarkerState.sourceId`
  // （直近の付与者）を見て判定する。`AppliedEffect`側には同じ判定を行う失効機構が
  // 無いため（`expiration.conditions`にもユニットの戦闘不能を判定するkindが
  // 存在しない）、`APPLY_MARKER`以外へ宣言すると「付与自体は成功するのに付与者が
  // 倒れても何も起きない」silent partial implementationになる。他の
  // `UNSUPPORTED_*`と同じくCatalogロード時点で拒否する。
  const sourceDefeatedDuration = durationOf(effectAction);
  if (
    sourceDefeatedDuration?.removeOnSourceDefeated === true &&
    effectAction.kind !== "APPLY_MARKER"
  ) {
    violations.push({
      targetId: effectAction.effectActionDefinitionId,
      rule: "UNSUPPORTED_SOURCE_DEFEATED_REMOVAL",
      message: `duration.removeOnSourceDefeated is only supported on APPLY_MARKER (R-EFF-10, M7-020): AppliedEffect has no source-defeat expiration mechanism, received kind "${effectAction.kind}"`,
    });
  }
  // R-EFF-12（`DYNAMIC_DURATION_ON_REAPPLY`、M7-014、Issue #268）: 再付与時の動的
  // 期間を解決するのは`resolveDurationOnReapply`（`effect-grant-service.ts`）を
  // 通る付与経路だけである。`APPLY_MARKER`は`marker-apply-service.ts`が
  // `stack.policy`（R-EFF-10）で再付与を解決してこの経路を通らず、FREEZEは
  // R-STS-03「再付与時に期間延長や増幅率加算を行わない」により
  // `grantFreezeStatus`が既存インスタンスをそのまま返す。どちらも`reapply`を
  // 宣言できてしまうと「付与自体は成功するのに期間だけ差し替わらない」silent
  // partial implementationになるため、`UNSUPPORTED_MARKER_DURATION`と同じく
  // Catalogロード時点で拒否する。
  const reapplyDuration = durationOf(effectAction);
  if (reapplyDuration?.reapply !== undefined) {
    if (effectAction.kind === "APPLY_MARKER") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_DYNAMIC_DURATION_REAPPLY",
        message:
          "APPLY_MARKER.duration.reapply is not supported: Marker re-application is resolved by stack.policy (R-EFF-10, marker-apply-service.ts), not by resolveDurationOnReapply",
      });
    }
    if (effectAction.kind === "APPLY_STATUS" && effectAction.payload.status === "FREEZE") {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_DYNAMIC_DURATION_REAPPLY",
        message:
          'APPLY_STATUS status "FREEZE" duration.reapply is not supported: freeze re-application is a no-op (R-STS-03, freeze-grant-service.ts), so the dynamic duration would never be evaluated',
      });
    }
  }
  checkRequiredCapabilities(
    effectAction.requiredCapabilities,
    effectAction.effectActionDefinitionId,
    capabilities,
    violations,
  );
}

/**
 * PRレビュー指摘[P1]（PR #256、Issue #184）: `EffectActionDefinition`が持つ
 * `FormulaDefinition`をkind横断で取り出す。`durationOf`と
 * 同じ網羅的`switch`とし、新しいkindの追加時にこの関数の更新漏れをコンパイル
 * エラーとして検出する。
 */
function formulasOf(effectAction: EffectActionDefinition): readonly FormulaDefinition[] {
  switch (effectAction.kind) {
    case "DAMAGE":
      return [effectAction.payload.formula, ...effectAction.payload.damageModifiers];
    case "HEAL":
    case "APPLY_CONTINUOUS_HEAL":
    case "APPLY_CONTINUOUS_DAMAGE":
    case "APPLY_STAT_MOD":
    case "APPLY_DAMAGE_MOD":
    case "APPLY_HEALING_MOD":
    case "MODIFY_RESOURCE_CAPACITY":
    case "APPLY_SHIELD":
    case "APPLY_ATTACK_DAMAGE_BONUS":
    case "APPLY_REFLECT":
      return [effectAction.payload.formula];
    case "APPLY_RESOURCE_GAIN_MOD":
      return [effectAction.payload.rateDelta];
    case "MODIFY_RESOURCE":
      return effectAction.payload.formula === undefined ? [] : [effectAction.payload.formula];
    case "APPLY_STATUS":
    case "REMOVE_EFFECTS":
    case "EFFECT_IMMUNITY":
    case "APPLY_MARKER":
    case "REMOVE_MARKER":
    case "APPLY_DEATH_SURVIVAL":
    case "APPLY_TARGET_REDIRECT":
    case "APPLY_COVER":
    case "APPLY_HEALING_LINK":
    case "APPLY_SUBUNIT":
    case "COOLDOWN_MANIPULATION":
      return [];
    default: {
      const exhaustive: never = effectAction;
      throw new Error(`unhandled EffectActionDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** `SUM`/`MIN`/`MAX`/`CLAMP`の入れ子を含めて`SUM_DAMAGE_*`参照を再帰的に探す。 */
function referencesSumDamageResult(formula: FormulaDefinition): boolean {
  switch (formula.kind) {
    case "DAMAGE_DEALT_RATIO":
    case "DAMAGE_RECEIVED_RATIO":
      return (
        formula.sourceResult === "SUM_DAMAGE_DEALT" ||
        formula.sourceResult === "SUM_DAMAGE_RECEIVED"
      );
    case "SUM":
    case "MIN":
    case "MAX":
      return formula.formulas.some(referencesSumDamageResult);
    case "CLAMP":
      return referencesSumDamageResult(formula.formula);
    default:
      return false;
  }
}

/**
 * `DurationDefinition`を運ぶkindだけ値を返す（`APPLY_MARKER`を含む）。
 * EFF-005/Issue #162: `AppliedEffect`スコープのRuntimeCounter（`counterUpdates`）
 * 宣言に`CAP_EFFECT_RUNTIME_COUNTER`を要求する検証のために、`duration`本体を
 * kindを問わず取り出す。網羅的な`switch`とし、新しいkindが
 * `effect-action-definition.ts`へ追加された際にこの関数の更新漏れをコンパイル
 * エラーとして検出する。
 */
function durationOf(effectAction: EffectActionDefinition): DurationDefinition | undefined {
  switch (effectAction.kind) {
    case "APPLY_CONTINUOUS_HEAL":
    case "APPLY_CONTINUOUS_DAMAGE":
    case "APPLY_STAT_MOD":
    case "APPLY_DAMAGE_MOD":
    case "APPLY_HEALING_MOD":
    case "MODIFY_RESOURCE_CAPACITY":
    case "APPLY_STATUS":
    case "APPLY_SHIELD":
    case "EFFECT_IMMUNITY":
    case "APPLY_DEATH_SURVIVAL":
    case "APPLY_TARGET_REDIRECT":
    case "APPLY_COVER":
    case "APPLY_REFLECT":
    case "APPLY_MARKER":
    case "APPLY_ATTACK_DAMAGE_BONUS":
    case "APPLY_RESOURCE_GAIN_MOD":
    case "APPLY_HEALING_LINK":
      return effectAction.payload.duration;
    case "DAMAGE":
    case "HEAL":
    case "MODIFY_RESOURCE":
    case "REMOVE_EFFECTS":
    case "REMOVE_MARKER":
    case "APPLY_SUBUNIT":
    case "COOLDOWN_MANIPULATION":
      return undefined;
    default: {
      const exhaustive: never = effectAction;
      throw new Error(`unhandled EffectActionDefinition kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Issue #129 「所有関係をpreflightで検証する」: Unitが所有するAS/PS/EXから
 * 到達可能な`COOLDOWN_MANIPULATION`が、同じUnitが所有するスキルだけを対象に
 * できることを検証する。対象スキルの存在自体は`validateEffectAction`の
 * `DANGLING_REFERENCE`が既に担うため、ここでは「存在するが他Unit所有」の
 * ケースだけを扱う。
 */
function checkCooldownManipulationOwnership(
  unit: UnitDefinition,
  ownedSkillIds: ReadonlySet<SkillDefinitionId>,
  skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  for (const skillId of ownedSkillIds) {
    const skill = skills.get(skillId);
    if (skill === undefined) {
      continue;
    }
    const refs = [
      ...collectEffectActionReferences(skill.resolution.steps),
      ...(skill.resolution.kind === "CHARGE"
        ? collectEffectActionReferences(skill.resolution.chargeRelease.steps)
        : []),
    ];
    for (const ref of refs) {
      const effectAction = effectActions.get(ref.effectActionDefinitionId);
      if (effectAction?.kind !== "COOLDOWN_MANIPULATION") {
        continue;
      }
      const targetSkillDefinitionId = effectAction.payload.targetSkillDefinitionId;
      if (skills.has(targetSkillDefinitionId) && !ownedSkillIds.has(targetSkillDefinitionId)) {
        violations.push({
          targetId: unit.unitDefinitionId,
          rule: "UNOWNED_SKILL_REFERENCE",
          message: `EffectAction "${effectAction.effectActionDefinitionId}" (COOLDOWN_MANIPULATION) targets SkillDefinition "${targetSkillDefinitionId}", which is not owned by unit "${unit.unitDefinitionId}"`,
        });
      }
    }
  }
}

/**
 * R-MEM-04「具体的な発生源 BattleUnit が必要なEffectActionをMemoryから使用する
 * 場合は、Catalog検証またはpreflightで拒否する」: Memoryは使用者ユニットを持たない
 * （source sideだけを持つ）ため、次を宣言するMemoryはCatalogロード時点で拒否する。
 *
 * - 使用者を必要とするEffectAction種別（下記`SOURCE_UNIT_REQUIRING_EFFECT_ACTION_KINDS`）。
 * - 対象参照`SELF`（R-MEM-04が明示的に禁止）。
 * - 使用者を基準にする`TargetSelectorDefinition`（`kind: SELF`、使用者からの距離順、
 *   `SELF_LOWEST_PRIORITY`、`base`が暗黙の使用者になる`area`）。
 *
 * これらは実行時（`requireSourceUnit`/`requireActorUnit`）も決定的に拒否するが、
 * 戦闘開始後に効果解決の途中で失敗させないため、ここで先に検出する
 * （`EVENT_PAYLOAD_REQUIRES_PS_SKILL`と同じ方針）。Formulaの`SKILL_SOURCE`参照は
 * `FormulaEvaluator`が評価時点で同じく明確に拒否する。
 */
const SOURCE_UNIT_REQUIRING_EFFECT_ACTION_KINDS = new Set<EffectActionDefinition["kind"]>([
  // 使用者の攻撃力・命中/会心・被ダメージ記録を必要とする。
  "DAMAGE",
  // 回復者（回復量Formulaの基準・`HealApplied.sourceUnitId`）を必要とする。
  "HEAL",
  "APPLY_CONTINUOUS_HEAL",
  // `ModifyResourceEventContext`/`CooldownManipulationEventContext`が発生源ユニットを要求する。
  "MODIFY_RESOURCE",
  "COOLDOWN_MANIPULATION",
]);

const SOURCE_UNIT_REQUIRING_ORDER_KEYS: ReadonlySet<string> = new Set([
  "NEAREST",
  "FARTHEST",
  "SELF_LOWEST_PRIORITY",
]);

const SELF_TARGET_REFERENCE_KINDS: ReadonlySet<string> = new Set(["SELF"]);

function selectorRequiresSourceUnit(selector: TargetSelectorDefinition): boolean {
  return selectorTreeSome(
    selector,
    (candidate) =>
      candidate.kind === "SELF" ||
      (candidate.kind === "BINDING_DERIVED" && candidate.base?.kind === "SELF") ||
      // `area`のbaseは`BINDING_DERIVED`以外では暗黙に使用者になる（R-TGT-09 #4）。
      (candidate.area !== undefined && candidate.kind !== "BINDING_DERIVED") ||
      candidate.order.some(
        (entry) => typeof entry === "string" && SOURCE_UNIT_REQUIRING_ORDER_KEYS.has(entry),
      ) ||
      candidate.filters.some((filter) => filterReferencesSelf(filter)),
  );
}

function filterReferencesSelf(filter: TargetFilterDefinition): boolean {
  switch (filter.kind) {
    case "EXCLUDE_RESOLVED_UNIT":
      return filter.reference.kind === "SELF";
    case "AND":
    case "OR":
      return filter.conditions.some((condition) => filterReferencesSelf(condition));
    case "NOT":
      return filterReferencesSelf(filter.condition);
    default:
      return false;
  }
}

/**
 * PR #260レビュー[P2]: EffectActionの`kind`だけでは、使用者BattleUnitを必要とする
 * 構成を網羅できない（`APPLY_STAT_MOD`のFormulaが`SKILL_SOURCE`を参照する、
 * `APPLY_HEALING_LINK`の`transferTo`が`SELF`を指す等）。payloadを再帰走査し、
 * EffectSequenceの**発生源**を指す参照が1つでも埋め込まれていれば拒否する。
 *
 * PR #260再レビュー[P2]: ただし`DurationDefinition`（`duration`）配下は「効果を
 * 保持する対象ユニット」のスコープであり、発生源スコープではない —
 * `expiration.conditions`の`SELF`は保持者を指し（`effect-expiration-condition-service.ts`
 * が各効果の保持者を`context.owner`として渡す）、`counterUpdates`も同じ
 * `AppliedEffect`インスタンス自身のcounterを指す。Memoryが付与する効果へ
 * 「保持者自身の状態で失効する」正常な特殊失効条件を書けなくならないよう、
 * このスコープは走査対象から外す。それ以外のpayloadフィールド
 * （`formula`/`rateDelta`等のFormula、`transferTo`/`redirectTo`/`coverer`/
 * `reflectTo`等のTargetReference）は解決時に発生源へ解決されるため、
 * 汎用走査のまま将来追加されるフィールドも覆う。
 */
const SOURCE_UNIT_REFERENCE_KINDS: ReadonlySet<string> = new Set([
  // `FormulaSourceReference.kind`（Formulaが使用者のstat/HPを読む）。
  "SKILL_SOURCE",
  // `TargetReference.kind`（`transferTo`等が使用者自身を指す）。
  "SELF",
  // PR #260再レビュー[P2]: 直前・累計DAMAGE結果は使用者ごとに記録される
  // （`DamageResultRegistry`は`BattleUnitId`キー）。使用者を持たないMemoryの
  // 解決では`lastResults`自体がFormula評価contextへ渡らないため、
  // `LAST_DAMAGE_*`/`SUM_DAMAGE_*`を読むFormula種別も評価不能として扱う。
  "DAMAGE_DEALT_RATIO",
  "DAMAGE_RECEIVED_RATIO",
]);

/**
 * `duration`配下で唯一、発生源ユニットを指す宣言。`payloadReferencesSourceUnit`が
 * `duration`を走査対象外にする代わりに、この1点だけを明示的に確認する。
 */
function effectActionDurationOwnedBySource(effectAction: EffectActionDefinition): boolean {
  return durationOf(effectAction)?.timeLimit?.owner === "EFFECT_SOURCE";
}

/** 発生源ではなく「効果保持者」のスコープを表すpayloadキー（走査対象外）。 */
const EFFECT_HOLDER_SCOPED_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["duration"]);

function payloadReferencesSourceUnit(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => payloadReferencesSourceUnit(entry));
  }
  if (typeof value === "object" && value !== null) {
    const kind = (value as { readonly kind?: unknown }).kind;
    if (typeof kind === "string" && SOURCE_UNIT_REFERENCE_KINDS.has(kind)) {
      return true;
    }
    return Object.entries(value).some(
      ([key, entry]) =>
        !EFFECT_HOLDER_SCOPED_PAYLOAD_KEYS.has(key) && payloadReferencesSourceUnit(entry),
    );
  }
  return false;
}

/**
 * PR #260レビュー[P2]: Memoryの`TriggerDefinition.condition`（およびEffectStepの
 * 各condition）が使用者BattleUnitを必要とするかどうか。`trigger-condition-evaluator.ts`
 * が`owner`不在で`DomainValidationError`にする条件種別と1対1で対応させる。
 *
 * - `POSITION_RELATION`: 所有者の座標を基準にする。
 * - `RUNTIME_COUNTER`: `SkillRuntime`/`AppliedEffect`スコープのcounter保持者を要求する
 *   （Memoryはどちらも持たない）。
 * - `ALIVE_UNIT_COUNT`の`excludeSelf`: 除外すべき「自身」が存在しない。
 * - 対象参照`SELF`（`TARGET_STATE`/`TARGET_HAS_MARKER`/`TARGET_SET_COUNT`等）。
 */
function conditionRequiresSourceUnit(condition: ConditionDefinition): boolean {
  switch (condition.kind) {
    case "POSITION_RELATION":
    case "RUNTIME_COUNTER":
      return true;
    case "ALIVE_UNIT_COUNT":
      return condition.excludeSelf === true;
    case "AND":
    case "OR":
      return condition.conditions.some((child) => conditionRequiresSourceUnit(child));
    case "NOT":
      return conditionRequiresSourceUnit(condition.condition);
    default:
      return collectConditionTargetReferences(condition).some(
        (reference) => reference.kind === "SELF",
      );
  }
}

/** EffectStep（BRANCH/RANDOM_BRANCH/REPEATの内側を含む）が持つ全conditionを再帰的に走査する。 */
function stepsSomeCondition(
  steps: readonly EffectStepDefinition[],
  predicate: (condition: ConditionDefinition) => boolean,
): boolean {
  for (const step of steps) {
    if (step.kind === "ACTION") {
      if (predicate(step.stepCondition) || predicate(step.targetCondition)) {
        return true;
      }
    } else if (step.kind === "BRANCH") {
      if (
        predicate(step.condition) ||
        stepsSomeCondition(step.thenSteps, predicate) ||
        stepsSomeCondition(step.elseSteps, predicate)
      ) {
        return true;
      }
    } else if (step.kind === "RANDOM_BRANCH") {
      if (step.branches.some((branch) => stepsSomeCondition(branch.steps, predicate))) {
        return true;
      }
    } else if (step.kind === "REPEAT" && stepsSomeCondition(step.steps, predicate)) {
      return true;
    }
  }
  return false;
}

function validateMemorySourceUnitIndependence(
  memory: MemoryDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  for (const triggeredEffect of memory.triggeredEffects) {
    const sequence = triggeredEffect.effectSequence;
    if (conditionRequiresSourceUnit(triggeredEffect.trigger.condition)) {
      violations.push({
        targetId: memory.memoryDefinitionId,
        rule: "MEMORY_REQUIRES_SOURCE_UNIT",
        message:
          "trigger condition needs an owner BattleUnit (POSITION_RELATION/RUNTIME_COUNTER/ALIVE_UNIT_COUNT excludeSelf/SELF reference), which Memory triggeredEffects do not have (R-MEM-04)",
      });
    }
    if (stepsSomeCondition(sequence.steps, conditionRequiresSourceUnit)) {
      violations.push({
        targetId: memory.memoryDefinitionId,
        rule: "MEMORY_REQUIRES_SOURCE_UNIT",
        message:
          "EffectStep condition needs an owner BattleUnit (POSITION_RELATION/RUNTIME_COUNTER/ALIVE_UNIT_COUNT excludeSelf/SELF reference), which Memory triggeredEffects do not have (R-MEM-04)",
      });
    }
    if (stepsContainTargetReferenceKinds(sequence.steps, SELF_TARGET_REFERENCE_KINDS)) {
      violations.push({
        targetId: memory.memoryDefinitionId,
        rule: "MEMORY_REQUIRES_SOURCE_UNIT",
        message:
          'Memory triggeredEffects cannot use the "SELF" target reference (they have no source BattleUnit, R-MEM-04)',
      });
    }
    for (const binding of sequence.targetBindings) {
      if (selectorRequiresSourceUnit(binding.selector)) {
        violations.push({
          targetId: memory.memoryDefinitionId,
          rule: "MEMORY_REQUIRES_SOURCE_UNIT",
          message: `targetBinding "${binding.targetBindingId}" resolves relative to the source unit (SELF/implicit area base/actor-relative order), which Memory triggeredEffects do not have (R-MEM-04)`,
        });
      }
    }
    for (const ref of collectEffectActionReferences(sequence.steps)) {
      const effectAction = effectActions.get(ref.effectActionDefinitionId);
      if (effectAction === undefined) {
        continue;
      }
      if (SOURCE_UNIT_REQUIRING_EFFECT_ACTION_KINDS.has(effectAction.kind)) {
        violations.push({
          targetId: memory.memoryDefinitionId,
          rule: "MEMORY_REQUIRES_SOURCE_UNIT",
          message: `EffectAction "${ref.effectActionDefinitionId}" (${effectAction.kind}) requires a source BattleUnit, which Memory triggeredEffects do not have (R-MEM-04)`,
        });
      } else if (effectActionDurationOwnedBySource(effectAction)) {
        // PR #260再レビュー[P2]と同じ理由の隣接ケース: `timeLimit.owner:
        // EFFECT_SOURCE`は「付与者の行動・ターン完了で減算する」意味であり、
        // 付与者ユニットが存在しないMemoryでは減算契機を特定できない
        // （実行時は`BATTLE`扱いへフォールバックする＝意味が静かに変わる）。
        violations.push({
          targetId: memory.memoryDefinitionId,
          rule: "MEMORY_REQUIRES_SOURCE_UNIT",
          message: `EffectAction "${ref.effectActionDefinitionId}" declares timeLimit.owner "EFFECT_SOURCE", whose decrement trigger is the granting unit's action/turn — Memory triggeredEffects have no source BattleUnit (R-MEM-04)`,
        });
      } else if (payloadReferencesSourceUnit(effectAction.payload)) {
        // PR #260レビュー[P2]: `kind`自体は使用者非依存でも、payload内のFormulaや
        // 対象参照が使用者を指していれば同じく解決できない。
        violations.push({
          targetId: memory.memoryDefinitionId,
          rule: "MEMORY_REQUIRES_SOURCE_UNIT",
          message: `EffectAction "${ref.effectActionDefinitionId}" (${effectAction.kind}) references the source BattleUnit in its payload (SKILL_SOURCE Formula, SELF target reference, or a LAST_DAMAGE_*/SUM_DAMAGE_* result), which Memory triggeredEffects do not have (R-MEM-04)`,
        });
      }
    }
    if (sequence.counterUpdates !== undefined && sequence.counterUpdates.length > 0) {
      violations.push({
        targetId: memory.memoryDefinitionId,
        rule: "MEMORY_REQUIRES_SOURCE_UNIT",
        message:
          "EffectSequence-scoped counterUpdates are held by the resolving unit, which Memory triggeredEffects do not have (R-MEM-04)",
      });
    }
  }
}

function validateMemory(
  memory: MemoryDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  if (memory.triggeredEffects.length > 0) {
    requireRuntimeCapability(
      memory.memoryDefinitionId,
      memory.requiredCapabilities,
      "CAP_MEMORY_TRIGGERED_EFFECT",
      "Memory triggeredEffects",
      violations,
    );
  }
  validateRuntimeCapabilityDeclarations(
    memory.memoryDefinitionId,
    memory.requiredCapabilities,
    memory.triggeredEffects.map((triggeredEffect) => triggeredEffect.effectSequence),
    memory.triggeredEffects.map((triggeredEffect) => triggeredEffect.trigger),
    undefined,
    undefined,
    violations,
  );
  for (const triggeredEffect of memory.triggeredEffects) {
    validateTrigger(triggeredEffect.trigger, memory.memoryDefinitionId, violations);
    validateLastResultDataFlow(
      triggeredEffect.effectSequence.steps,
      memory.memoryDefinitionId,
      violations,
    );
    validateMixedStepTargetSetCondition(
      triggeredEffect.effectSequence.steps,
      memory.memoryDefinitionId,
      violations,
    );
    validateBranchTargetStateUnboundedReference(
      triggeredEffect.effectSequence,
      memory.memoryDefinitionId,
      violations,
    );
    validateEffectActionReferences(
      triggeredEffect.effectSequence.steps,
      effectActions,
      memory.memoryDefinitionId,
      violations,
    );
  }
  validateMemorySourceUnitIndependence(memory, effectActions, violations);
  checkRequiredCapabilities(
    memory.requiredCapabilities,
    memory.memoryDefinitionId,
    capabilities,
    violations,
  );
}

export function buildCatalogIndex(definitions: CatalogDefinitions): CatalogIndex {
  const violations: CatalogIntegrityViolation[] = [];

  const capabilities = indexById(
    definitions.capabilities,
    (c) => c.capabilityId,
    "Capability",
    violations,
  );
  const effectActions = indexById(
    definitions.effectActions,
    (e) => e.effectActionDefinitionId,
    "EffectAction",
    violations,
  );
  const skills = indexById(definitions.skills, (s) => s.skillDefinitionId, "Skill", violations);
  const units = indexById(definitions.units, (u) => u.unitDefinitionId, "Unit", violations);
  const memories = indexById(
    definitions.memories,
    (m) => m.memoryDefinitionId,
    "Memory",
    violations,
  );

  for (const capability of capabilities.values()) {
    validateCapabilityVerification(capability, units, skills, effectActions, memories, violations);
  }

  for (const effectAction of effectActions.values()) {
    validateEffectAction(effectAction, effectActions, skills, capabilities, violations);
  }
  for (const skill of skills.values()) {
    validateSkill(skill, effectActions, capabilities, violations);
  }
  for (const unit of units.values()) {
    validateUnit(unit, skills, effectActions, capabilities, violations);
  }
  for (const memory of memories.values()) {
    validateMemory(memory, effectActions, capabilities, violations);
  }

  if (violations.length > 0) {
    throw new CatalogIntegrityError(violations);
  }

  return {
    units: toReadonlyMap(units),
    skills: toReadonlyMap(skills),
    effectActions: toReadonlyMap(effectActions),
    memories: toReadonlyMap(memories),
    capabilities: toReadonlyMap(capabilities),
  };
}
