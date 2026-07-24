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
import type {
  EffectActionReference,
  EffectSequence,
  EffectStepDefinition,
} from "../definitions/effect-sequence.js";
import type { MemoryDefinition } from "../definitions/memory-definition.js";
import { toReadonlyMap } from "../../shared/readonly-map.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type { TriggerDefinition } from "../definitions/trigger-definition.js";
import type { TargetSelectorDefinition } from "../definitions/target-selector-definition.js";
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
  "UNSUPPORTED_MARKER_LINKED_GROUP",
  "UNSUPPORTED_MARKER_DURATION",
  "MISSING_PRECEDING_RESULT",
  "MIXED_STEP_TARGET_SET_CONDITION",
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
  | "CAP_TRIGGER_CONTEXT";

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
        conditionContainsTargetReferenceKind(step.condition, kinds)
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

function stepsContainNonTrueCondition(steps: readonly EffectStepDefinition[]): boolean {
  for (const step of steps) {
    if ((step.kind === "ACTION" || step.kind === "BRANCH") && step.condition.kind !== "TRUE") {
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
    if (
      (step.kind === "ACTION" || step.kind === "BRANCH") &&
      conditionContainsTargetSetCount(step.condition)
    ) {
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
 * PRレビュー[P2]再々々指摘・再々々々指摘（Issue #227）: 対象別条件
 * （`TARGET_STATE`/`TARGET_HAS_MARKER`、対象ごとに真偽が変わる「対象ごとの
 * 適用可否フィルタ」）と`TARGET_SET_COUNT`（step全体で1回だけ評価する「step
 * 自体のskip判定」）は、単一のbooleanへ還元する意味論が本質的に異なる。
 * 同じconditionツリーに`AND`/`OR`/`NOT`で混在させると、量化の位置（対象別
 * leafごとに`exists`を取ってから合成するか、複合式を対象ごとに評価してから
 * `exists`を取るか）によって結果が変わり得るだけでなく、後者の場合でも
 * 「対象別条件が全員falseなら対象0件成立扱い」（R-SKL-06）と「集合条件が
 * falseならEffectStepSkipped」という2つの契約のどちらを優先すべきか一意に
 * 定まらない。加えて、`TARGET_STATE`/`TARGET_HAS_MARKER`が`step.target`とは
 * 異なる参照（`SELF`等）であっても、`TARGET_SET_COUNT`と同じconditionツリーに
 * 存在する限り実行時は`TARGET_SET_COUNT`単独経路（`targetContext: undefined`）
 * で評価され例外になるため、参照先を問わず拒否する。`ACTION`/`BRANCH`いずれの
 * `condition`も対象（`BRANCH`のconditionも同じ`targetContext: undefined`経路で
 * 評価されるため同じ危険がある）。混在が将来必要になった場合は、`condition`を
 * stepワイド判定用と対象別フィルタ用のスコープへ分離する専用スキーマを
 * 別Issueで設計する。
 */
function collectMixedStepTargetSetConditionPaths(
  steps: readonly EffectStepDefinition[],
  path: string,
): readonly string[] {
  const paths: string[] = [];
  steps.forEach((step, index) => {
    const stepPath = `${path}[${index}]`;
    if (
      (step.kind === "ACTION" || step.kind === "BRANCH") &&
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
      if (!definitelyAssigned) {
        if (conditionReferencesLastResult(step.condition)) {
          violations.push({
            targetId: ownerId,
            rule: "MISSING_PRECEDING_RESULT",
            message: `${path}.condition references kind "LAST_RESULT" but no preceding EffectAction result is definitely assigned on every path reaching this step`,
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
      return definitelyAssigned || step.condition.kind === "TRUE";
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
  for (const [capabilityId, reason] of [
    ["CAP_TARGET_FILTER_ORDER", "Target selector filter/non-default order"],
    ["CAP_TARGET_DERIVED_AREA", "BINDING_DERIVED/area target selector"],
    ["CAP_TARGET_BINDING_FALLBACK", "Target selector fallback"],
    ["CAP_EFFECT_STEP_CONDITION", "EffectStep non-TRUE condition"],
    ["CAP_EFFECT_STEP_SET_CONDITION", "EffectStep TARGET_SET_COUNT condition"],
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
  checkRequiredCapabilities(
    effectAction.requiredCapabilities,
    effectAction.effectActionDefinitionId,
    capabilities,
    violations,
  );
}

/**
 * `DurationDefinition`を運ぶkindだけ値を返す（`APPLY_MARKER`を含む）。
 * EFF-005/Issue #162: `AppliedEffect`スコープのRuntimeCounter（`counterUpdates`）
 * 宣言に`CAP_EFFECT_RUNTIME_COUNTER`を要求する検証のために、`duration`本体を
 * kindを問わず取り出す。`linkedEffectGroupIdOf`と同じ網羅的`switch`。
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
 * `linkedEffectGroupId`を持つ`DurationDefinition`を運ぶkindだけ値を返す
 * `undefined`は「このkindはDurationを持たない」または「Durationはあるが
 * `linkedEffectGroupId`がnull」を表す。`isMarker`は`APPLY_MARKER`（`MarkerState`
 * を生成する）かどうかを表し、それ以外のDuration保持kindはすべて`AppliedEffect`
 * を生成する（`05_ドメインモデル.md`「AppliedEffect」参照）。網羅的な`switch`とし、
 * 新しいkindが`effect-action-definition.ts`へ追加された際にこの関数の更新漏れを
 * コンパイルエラーとして検出する。
 */
function linkedEffectGroupIdOf(
  effectAction: EffectActionDefinition,
): { readonly groupId: string; readonly isMarker: boolean } | undefined {
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
    case "APPLY_REFLECT": {
      const groupId = effectAction.payload.duration.linkedEffectGroupId;
      return groupId === null ? undefined : { groupId, isMarker: false };
    }
    case "APPLY_MARKER": {
      const groupId = effectAction.payload.duration.linkedEffectGroupId;
      return groupId === null ? undefined : { groupId, isMarker: true };
    }
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
 * PR #210再レビュー[P2]: R-EFF-09は同じ`linkedEffectGroupId`を持つ`AppliedEffect`と
 * `MarkerState`を同一の親子連動グループとして扱う契約だが、EFF-004時点の
 * `collectMarkerLinkedGroupCascade`（`marker-linked-group.ts`）は`MarkerState`
 * 同士のカスケードだけを実装している（`AppliedEffect`をまたぐカスケードは
 * 利用するproduction Marker定義が現れるまで対象外）。Marker同士のグループは
 * 実装済みのため拒否しない — 同じ`linkedEffectGroupId`が`APPLY_MARKER`と
 * それ以外のDuration保持kindの両方で使われている場合（cross-type）だけを
 * Catalogロード時点で明示的に拒否し、preflightを通過した定義が実際には
 * カスケードされない状態を防ぐ。単一Definitionだけでは判定できないため、
 * 全`EffectActionDefinition`が出揃った後にCatalog全体を横断して検証する。
 */
function validateMarkerLinkedGroupCascadeSupport(
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
  const nonMarkerGroupIds = new Set<string>();
  for (const effectAction of effectActions.values()) {
    const info = linkedEffectGroupIdOf(effectAction);
    if (info !== undefined && !info.isMarker) {
      nonMarkerGroupIds.add(info.groupId);
    }
  }
  for (const effectAction of effectActions.values()) {
    const info = linkedEffectGroupIdOf(effectAction);
    if (info !== undefined && info.isMarker && nonMarkerGroupIds.has(info.groupId)) {
      violations.push({
        targetId: effectAction.effectActionDefinitionId,
        rule: "UNSUPPORTED_MARKER_LINKED_GROUP",
        message: `APPLY_MARKER.duration.linkedEffectGroupId "${info.groupId}" is shared with a non-Marker EffectActionDefinition: the AppliedEffect<->MarkerState cross-type linkedEffectGroup cascade (R-EFF-09) is not implemented (marker-linked-group.ts only cascades Marker-to-Marker)`,
      });
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
    validateEffectActionReferences(
      triggeredEffect.effectSequence.steps,
      effectActions,
      memory.memoryDefinitionId,
      violations,
    );
  }
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
  validateMarkerLinkedGroupCascadeSupport(effectActions, violations);
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
