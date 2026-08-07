import type { EffectActionDefinitionId } from "../definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import { collectEffectActionReferences } from "../definitions/effect-step-walk.js";
import type { MemoryDefinition } from "../definitions/memory-definition.js";
import type {
  TargetFilterDefinition,
  TargetSelectorDefinition,
} from "../definitions/target-selector-definition.js";
import type { TriggerDefinition } from "../definitions/trigger-definition.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import {
  collectConditionEffectActionReferences,
  conditionRequiresSourceUnit,
  conditionUsesGrantedBy,
} from "./condition-inspection.js";
import { durationOf } from "./effect-action-inspection.js";
import {
  collectStepConditionEffectActionReferences,
  stepsContainTargetReferenceKinds,
  stepsSomeCondition,
} from "./effect-step-inspection.js";
import {
  validateBranchTargetStateUnboundedReference,
  validateConditionEffectActionReferences,
  validateDamageLinkBindingReferences,
  validateEffectActionReferences,
  validateGrantedByScope,
  validateMixedStepTargetSetCondition,
} from "./effect-sequence-integrity.js";
import { validateLastResultDataFlow } from "./last-result-data-flow.js";
import { selectorTreeSome } from "./target-reference-cardinality.js";
import { validateTrigger } from "./trigger-integrity.js";

/**
 * R-MEM-04「具体的な発生源 BattleUnit が必要なEffectActionをMemoryから使用する
 * 場合は、Catalog検証またはpreflightで拒否する」: Memoryは使用者ユニットを持たない
 * （source sideだけを持つ）ため、次を宣言するMemoryはCatalogロード時点で拒否する。
 *
 * - 使用者を必要とするEffectAction種別（`SOURCE_UNIT_REQUIRING_EFFECT_ACTION_KINDS`）。
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

/**
 * EffectActionの`kind`だけでは、使用者BattleUnitを必要とする構成を網羅できない
 * （`APPLY_STAT_MOD`のFormulaが`SKILL_SOURCE`を参照する、`APPLY_HEALING_LINK`の
 * `transferTo`が`SELF`を指す等）。payloadを再帰走査し、EffectSequenceの**発生源**を
 * 指す参照が1つでも埋め込まれていれば拒否する。
 *
 * ただし`DurationDefinition`（`duration`）配下は「効果を保持する対象ユニット」の
 * スコープであり、発生源スコープではない — `expiration.conditions`の`SELF`は保持者を
 * 指し（`effect-expiration-condition-service.ts`が各効果の保持者を`context.owner`として
 * 渡す）、`counterUpdates`も同じ`AppliedEffect`インスタンス自身のcounterを指す。
 * Memoryが付与する効果へ「保持者自身の状態で失効する」正常な特殊失効条件を書けなく
 * ならないよう、このスコープは走査対象から外す。それ以外のpayloadフィールド
 * （`formula`/`rateDelta`等のFormula、`transferTo`/`redirectTo`/`coverer`/`reflectTo`等の
 * TargetReference）は解決時に発生源へ解決されるため、汎用走査のまま将来追加される
 * フィールドも覆う。
 */
const SOURCE_UNIT_REFERENCE_KINDS: ReadonlySet<string> = new Set([
  // `FormulaSourceReference.kind`（Formulaが使用者のstat/HPを読む）。
  "SKILL_SOURCE",
  // `TargetReference.kind`（`transferTo`等が使用者自身を指す）。
  "SELF",
  // 直前・累計DAMAGE結果は使用者ごとに記録される（`DamageResultRegistry`は
  // `BattleUnitId`キー）。使用者を持たないMemoryの解決では`lastResults`自体が
  // Formula評価contextへ渡らないため、`LAST_DAMAGE_*`/`SUM_DAMAGE_*`を読む
  // Formula種別も評価不能として扱う。
  "DAMAGE_DEALT_RATIO",
  "DAMAGE_RECEIVED_RATIO",
]);

/** 発生源ではなく「効果保持者」のスコープを表すpayloadキー（走査対象外）。 */
const EFFECT_HOLDER_SCOPED_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["duration"]);

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

/**
 * `duration`配下で唯一、発生源ユニットを指す宣言。`payloadReferencesSourceUnit`が
 * `duration`を走査対象外にする代わりに、この1点だけを明示的に確認する。
 */
function effectActionDurationOwnedBySource(effectAction: EffectActionDefinition): boolean {
  return durationOf(effectAction)?.timeLimit?.owner === "EFFECT_SOURCE";
}

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
 * Memoryのtrigger条件は`grantedBy`を評価できない。`memory-trigger-matcher.ts`が
 * 渡す評価contextはR-MEM-04どおり`ownerSide`（陣営）だけで、比較相手の`BattleUnit`
 * （`owner`）を持たないため、実行時には常に`undefined`が渡り条件が必ず偽になる。
 * Memoryには「自身が付与した」に相当する付与者ユニットがそもそも存在しない
 * （`MEMORY_REQUIRES_SOURCE_UNIT`と同じ性質の制約）ため、Skillの`triggers[]`と違い
 * Memory側は全面的に拒否する。
 */
function validateMemoryTriggerGrantedBy(
  trigger: TriggerDefinition,
  ownerId: string,
  violations: CatalogIntegrityViolation[],
): void {
  if (!conditionUsesGrantedBy(trigger.condition)) {
    return;
  }
  violations.push({
    targetId: ownerId,
    rule: "GRANTED_BY_OUTSIDE_TRIGGER",
    message:
      "TARGET_HAS_EFFECT.grantedBy cannot be used in a Memory trigger condition: Memory has no owning BattleUnit (R-MEM-04), so the evaluator receives only ownerSide and the AppliedEffect.sourceUnitId comparison would silently never match (DMG-007 Issue #187)",
  });
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
        // `timeLimit.owner: EFFECT_SOURCE`は「付与者の行動・ターン完了で減算する」
        // 意味であり、付与者ユニットが存在しないMemoryでは減算契機を特定できない
        // （実行時は`BATTLE`扱いへフォールバックする＝意味が静かに変わる）。
        violations.push({
          targetId: memory.memoryDefinitionId,
          rule: "MEMORY_REQUIRES_SOURCE_UNIT",
          message: `EffectAction "${ref.effectActionDefinitionId}" declares timeLimit.owner "EFFECT_SOURCE", whose decrement trigger is the granting unit's action/turn — Memory triggeredEffects have no source BattleUnit (R-MEM-04)`,
        });
      } else if (payloadReferencesSourceUnit(effectAction.payload)) {
        // `kind`自体は使用者非依存でも、payload内のFormulaや対象参照が使用者を
        // 指していれば同じく解決できない。
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

export function validateMemory(
  memory: MemoryDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
  violations: CatalogIntegrityViolation[],
): void {
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
    validateDamageLinkBindingReferences(
      triggeredEffect.effectSequence,
      memory.memoryDefinitionId,
      effectActions,
      violations,
    );
    validateGrantedByScope(
      triggeredEffect.effectSequence,
      undefined,
      memory.memoryDefinitionId,
      violations,
    );
    validateMemoryTriggerGrantedBy(triggeredEffect.trigger, memory.memoryDefinitionId, violations);
    validateConditionEffectActionReferences(
      [
        ...collectConditionEffectActionReferences(triggeredEffect.trigger.condition),
        ...collectStepConditionEffectActionReferences(triggeredEffect.effectSequence.steps),
      ],
      effectActions,
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
}
