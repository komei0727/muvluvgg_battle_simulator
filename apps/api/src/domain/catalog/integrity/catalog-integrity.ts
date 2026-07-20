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

function stepsContainTargetReferenceKinds(
  steps: readonly EffectStepDefinition[],
  kinds: ReadonlySet<string>,
): boolean {
  for (const step of steps) {
    if (step.kind === "ACTION") {
      if (kinds.has(step.target.kind)) {
        return true;
      }
    } else if (step.kind === "BRANCH") {
      if (
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
  const runtimeTriggers = [
    ...skill.triggers,
    ...skill.counterUpdates.map((counterUpdate) => counterUpdate.trigger),
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
  checkRequiredCapabilities(
    effectAction.requiredCapabilities,
    effectAction.effectActionDefinitionId,
    capabilities,
    violations,
  );
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
