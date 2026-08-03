import type { CapabilityDefinition } from "../capability/capability-definition.js";
import type {
  CapabilityId,
  EffectActionDefinitionId,
  MemoryDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../definitions/catalog-ids.js";
import type { ConditionDefinition } from "../definitions/condition-definition.js";
import type { EffectActionDefinition } from "../definitions/effect-action-definition.js";
import type { EffectSequence, EffectStepDefinition } from "../definitions/effect-sequence.js";
import type { MemoryDefinition } from "../definitions/memory-definition.js";
import type { SkillDefinition } from "../definitions/skill-definition.js";
import type { TriggerDefinition } from "../definitions/trigger-definition.js";
import type { UnitDefinition } from "../definitions/unit-definition.js";
import type { CatalogIntegrityViolation } from "./catalog-integrity-violation.js";
import {
  containsStepKind,
  LAST_RESULT_TARGET_KINDS,
  stepsContainEventPayloadCondition,
  stepsContainNonTrueCondition,
  stepsContainSetCondition,
  stepsContainTargetReferenceKinds,
} from "./effect-step-inspection.js";
import { selectorTreeSome } from "./target-reference-cardinality.js";

/**
 * `requiredCapabilities`の宣言検証。`checkRequiredCapabilities`は列挙済み
 * Capabilityの存在・schemaStatusしか見ないため、「その構成を使っているのに
 * 宣言していない」漏れは`requireRuntimeCapability`が定義構造から個別に検出する
 * （Capability→production定義の追跡可能性を保つ）。
 */

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

export type RuntimeStructuralCapabilityId =
  | "CAP_ACTION_ACTIVATION_CONDITION"
  | "CAP_CHARGE_RESTRICTION"
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

export function requireRuntimeCapability(
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

export function validateRuntimeCapabilityDeclarations(
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
    // CAP_TRIGGER_PAYLOAD_IN_RESOLUTION（Issue #247 M7-001D）: `EVENT_PAYLOAD`は
    // PS発動を引き起こしたトリガーイベントのpayloadだけを参照できる
    // （`PassiveActivationRuntime`が`EffectActionGroupContext.triggerEventPayload`へ
    // 供給する）。AS/EX active skillの解決（`action-skill-use-resolver.ts`の
    // `resolveSkillUse`）はこのフィールドを一切populateしないため、schemaは受理して
    // しまってもCatalogロード時点で明確に拒否する — 実行時まで待つと
    // `evaluateEffectStepCondition`が`DomainValidationError`を投げ、行動選択後に
    // 解決が途中で失敗してしまう。
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

export function checkRequiredCapabilities(
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

export function validateCapabilityVerification(
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
