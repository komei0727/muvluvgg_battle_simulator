import type { EffectActionDefinitionId } from "../definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { TargetReference } from "../definitions/references.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type { TargetSelectorDefinition } from "../definitions/target-selector-definition.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import {
  collectConditionEffectActionReferences,
  collectConditionTargetReferencePaths,
  collectTargetStateOrMarkerReferences,
} from "./condition-inspection.js";
import {
  collectStepConditionEffectActionReferences,
  stepsContainEventPayloadCondition,
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
import {
  buildBindingSelectors,
  targetReferenceIsSingleUnit,
} from "./target-reference-cardinality.js";
import { validateTrigger } from "./trigger-integrity.js";

/**
 * `activationCondition`が参照できる`TargetReference`の種別は、評価する側の実装で
 * skill typeごとに異なる。
 *
 * - AS/EX: `evaluateActivationCondition`（`lifecycle/activation-condition-evaluator.ts`）が
 *   使用者自身（`SELF`）と行動選択時点で解決済みの`BINDING`だけを解決する。行動選択には
 *   トリガーイベントも直前結果も存在しないため、それ以外は実行時に必ず例外になる。
 * - PS: `evaluateTriggerCondition`（`triggering/trigger-condition-evaluator.ts`）の
 *   `resolveTargetReferenceIds`が`SELF`/`TRIGGER_SOURCE`/`TRIGGER_TARGET`だけを解決する。
 *   `BINDING`はEffectSequence文脈を前提とするため候補判定時には解決できない。
 */
const ACTIVATION_CONDITION_REFERENCE_KINDS: Readonly<
  Record<"ACTION" | "PASSIVE", ReadonlySet<TargetReference["kind"]>>
> = {
  ACTION: new Set(["SELF", "BINDING"]),
  PASSIVE: new Set(["SELF", "TRIGGER_SOURCE", "TRIGGER_TARGET"]),
};

/**
 * `activationCondition`のCatalog契約を、実際に評価する側の契約と一致させる
 * （Issue #248）。2つの独立した制約を課す。
 *
 * 1. 参照kind（skill typeごと、`ACTIVATION_CONDITION_REFERENCE_KINDS`）。評価器が
 *    解決できない種別は、Catalogを通過しても行動選択・候補判定の時点で必ず
 *    `DomainValidationError`になる。
 * 2. 対象数（AS/EXのみ）。`evaluateActivationCondition`は`evaluateEffectStepCondition`を
 *    再利用するため、BRANCHの`condition`とまったく同じ「高々1体」制約が効く
 *    （量化規則を発明せずに済む範囲へ意図的に限定している）。PSは
 *    `evaluateTriggerCondition`が解決済み`BattleUnitId`集合へ存在量化するため
 *    複数対象でも評価でき、この制約の対象外とする。
 *
 * 対象数の制約は対象ごとに真偽が変わる3 kind（`TARGET_STATE`/`TARGET_HAS_MARKER`/
 * `TARGET_HAS_EFFECT`）にだけ課す — `TARGET_SET_COUNT`は集合全体を1回だけ数える
 * kindであり、複数対象のbindingを参照するのが本来の用途である
 * （production例: `SKL_LYDIA_GENIUS_AS1`/`SKL_ELENA_MOODMAKER_AS1`）。
 */
function validateActivationConditionReferences(
  skill: SkillDefinition,
  violations: CatalogIntegrityViolation[],
): void {
  const activationCondition = skill.activationCondition;
  if (activationCondition === undefined) {
    return;
  }
  const scope = skill.skillType === "PS" ? "PASSIVE" : "ACTION";
  const allowedKinds = ACTIVATION_CONDITION_REFERENCE_KINDS[scope];
  // CHARGEの`activationCondition`は行動選択時に評価されるため、解決される
  // `targetBindings`は開始側（`skill.resolution.targetBindings`、
  // `action-selection-policy.ts`の`resolveAllTargetBindings`が見るもの）だけである。
  // `chargeRelease`側のbindingを混ぜると、解放側にしか無いbindingの参照を通してしまい、
  // 同じIDが両側にある場合は解放側のselectorが開始側の単一対象性を上書きしてしまう。
  const bindingSelectors: ReadonlyMap<string, TargetSelectorDefinition> = buildBindingSelectors(
    skill.resolution.targetBindings,
  );

  for (const { reference, path } of collectConditionTargetReferencePaths(
    activationCondition,
    "activationCondition",
  )) {
    if (!allowedKinds.has(reference.kind)) {
      violations.push({
        targetId: skill.skillDefinitionId,
        rule: "ACTIVATION_CONDITION_UNSUPPORTED_REFERENCE",
        message: `${path}: a ${skill.skillType} activationCondition references TargetReference kind "${reference.kind}", which its evaluator cannot resolve (allowed: ${[...allowedKinds].join("/")} — AS/EX are evaluated at action-selection time with no triggering event, PS candidate detection has no resolved TargetBinding, Issue #248)`,
      });
    }
  }

  if (scope === "PASSIVE") {
    return;
  }
  for (const { reference, path } of collectTargetStateOrMarkerReferences(
    activationCondition,
    "activationCondition",
  )) {
    if (!targetReferenceIsSingleUnit(reference, bindingSelectors)) {
      violations.push({
        targetId: skill.skillDefinitionId,
        rule: "ACTIVATION_CONDITION_UNBOUNDED_REFERENCE",
        message: `${path}: an AS/EX activationCondition evaluates TARGET_STATE/TARGET_HAS_MARKER/TARGET_HAS_EFFECT against a TargetReference that is not guaranteed to resolve to at most one unit (only SELF, or a charge-start BINDING whose selector has kind SELECT and count 1, are supported — action-selection evaluation has no per-target context to quantify over multiple units, Issue #248)`,
      });
    }
  }
}

export function validateSkill(
  skill: SkillDefinition,
  effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>,
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
    validateDamageLinkBindingReferences(
      sequence,
      skill.skillDefinitionId,
      effectActions,
      violations,
    );
    validateGrantedByScope(
      sequence,
      skill.activationCondition,
      skill.skillDefinitionId,
      violations,
    );
    validateConditionEffectActionReferences(
      collectStepConditionEffectActionReferences(sequence.steps),
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  // 条件を置ける残りの位置（`activationCondition`とtrigger群）も同じ規則で走査する。
  if (skill.activationCondition !== undefined) {
    validateConditionEffectActionReferences(
      collectConditionEffectActionReferences(skill.activationCondition),
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  validateActivationConditionReferences(skill, violations);
  const runtimeTriggers = [
    ...skill.triggers,
    ...skill.counterUpdates.map((counterUpdate) => counterUpdate.trigger),
    ...sequences.flatMap((sequence) =>
      (sequence.counterUpdates ?? []).map((counterUpdate) => counterUpdate.trigger),
    ),
  ];
  for (const trigger of runtimeTriggers) {
    validateConditionEffectActionReferences(
      collectConditionEffectActionReferences(trigger.condition),
      effectActions,
      skill.skillDefinitionId,
      violations,
    );
  }
  // Issue #247 M7-001D: `EVENT_PAYLOAD`はPS発動を引き起こしたトリガーイベントの
  // payloadだけを参照できる（`PassiveActivationRuntime`が
  // `EffectActionGroupContext.triggerEventPayload`へ供給する）。AS/EXの解決
  // （`action-skill-use-resolver.ts`の`resolveSkillUse`）はこのフィールドを一切
  // populateしないため、schemaが受理してもCatalogロード時点で拒否する — 実行時まで
  // 待つと`evaluateEffectStepCondition`が`DomainValidationError`を投げ、行動選択後に
  // 解決が途中で失敗してしまう。
  if (
    (skill.skillType === "AS" || skill.skillType === "EX") &&
    sequences.some((sequence) => stepsContainEventPayloadCondition(sequence.steps))
  ) {
    violations.push({
      targetId: skill.skillDefinitionId,
      rule: "EVENT_PAYLOAD_REQUIRES_PS_SKILL",
      message: `EVENT_PAYLOAD condition requires a PS Skill (the triggering event's payload only exists during a passive activation) — "${skill.skillDefinitionId}" is skillType "${skill.skillType}"`,
    });
  }
  for (const trigger of skill.triggers) {
    validateTrigger(trigger, skill.skillDefinitionId, violations);
  }
  for (const counterUpdate of skill.counterUpdates) {
    validateTrigger(counterUpdate.trigger, skill.skillDefinitionId, violations);
  }
}
