import type {
  ActionKind,
  DamageType,
  EffectImmunityCategory,
  ResourceKind,
  ResourceModifyOperation,
} from "./catalog-enums.js";
import {
  createCapabilityId,
  createEffectActionDefinitionId,
  createMarkerId,
  createSkillDefinitionId,
  type EffectActionDefinitionId,
} from "./catalog-ids.js";
import { COMPARISON_OPERATORS } from "./condition-definition.js";
import {
  createDurationDefinition,
  type DurationDefinition,
  type DurationDefinitionInput,
} from "./duration-definition.js";
import {
  EFFECT_ACTION_KINDS,
  type EffectActionDefinition,
  type EffectActionDefinitionInput,
  type EffectActionKind,
  type EffectActionPayload,
} from "./effect-action-definition.js";
import {
  COOLDOWN_MANIPULATION_OPERATIONS,
  REFLECT_TIMINGS,
  RESOURCE_CAPACITY_OPERATIONS,
  STATUS_KINDS,
  type DamageThreshold,
  type RemoveEffectsPayload,
} from "./effect-action-payload.js";
import {
  createFormulaDefinition,
  type FormulaDefinition,
  type FormulaDefinitionInput,
} from "./formula-definition.js";
import { createTargetReference, type TargetReferenceInput } from "./references.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertArray,
  assertBoolean,
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertKnownKeys,
  assertNonEmptyArray,
  assertNullableInteger,
} from "../../shared/validate.js";

const DAMAGE_TYPES = ["PHYSICAL", "EN"] as const;
const CRITICAL_MODES = ["NORMAL", "GUARANTEED", "PREVENTED"] as const;
const ACCURACY_MODES = ["NORMAL", "GUARANTEED"] as const;
const RESOURCE_KINDS = ["AP", "PP", "EX_GAUGE"] as const;
const RESOURCE_OPERATIONS = ["ADD", "SET", "SET_TO_MAX", "DISTRIBUTE"] as const;
const STAT_KINDS = [
  "MAXIMUM_HP",
  "ATTACK",
  "DEFENSE",
  "CRITICAL_RATE",
  "CRITICAL_DAMAGE_BONUS",
  "AFFINITY_BONUS",
  "ACTION_SPEED",
] as const;
const STAT_VALUE_TYPES = ["RATIO", "FIXED"] as const;
const STACKING_MODES = ["STACKABLE"] as const;
const DAMAGE_MOD_DIRECTIONS = ["OUTGOING", "INCOMING"] as const;
const ACTION_KINDS = ["DAMAGE", "DEBUFF", "ANY"] as const;
const EFFECT_IMMUNITY_CATEGORIES = [
  "DEBUFF",
  "STATUS",
  "MARKER",
  "DAMAGE_MOD",
  "SPECIFIC_EFFECT",
] as const;
const MARKER_STACK_POLICIES = ["ADD", "KEEP_EXISTING", "REFRESH", "REPLACE"] as const;
const OVERHEAL_POLICIES = ["DISCARD"] as const;

const PAYLOAD_ALLOWED_KEYS: Record<EffectActionKind, readonly string[]> = {
  DAMAGE: [
    "damageType",
    "formula",
    "hitCount",
    "critical",
    "accuracy",
    "piercing",
    "damageModifiers",
    "link",
  ],
  HEAL: ["formula", "overheal"],
  APPLY_CONTINUOUS_HEAL: ["formula", "timing", "duration"],
  APPLY_CONTINUOUS_DAMAGE: ["damageType", "formula", "timing", "duration"],
  APPLY_STAT_MOD: ["stat", "valueType", "formula", "stacking", "duration"],
  APPLY_DAMAGE_MOD: ["direction", "damageType", "formula", "stacking", "duration"],
  APPLY_HEALING_MOD: ["direction", "formula", "stacking", "duration"],
  MODIFY_RESOURCE: ["resource", "operation", "formula", "bounds"],
  MODIFY_RESOURCE_CAPACITY: ["resource", "operation", "formula", "duration"],
  APPLY_STATUS: [
    "status",
    "duration",
    "probability",
    "appliesTo",
    "damageAmplificationOnBreak",
    "damageThreshold",
  ],
  APPLY_SHIELD: ["formula", "duration"],
  REMOVE_EFFECTS: ["categories", "effectActionDefinitionIds"],
  EFFECT_IMMUNITY: ["categories", "effectActionDefinitionIds", "duration", "maxBlocks"],
  APPLY_MARKER: ["markerId", "stack", "duration"],
  REMOVE_MARKER: ["markerId"],
  APPLY_DEATH_SURVIVAL: ["trigger", "survivalHp", "healAfterSurvival", "duration"],
  APPLY_TARGET_REDIRECT: ["redirectTo", "appliesTo", "duration"],
  APPLY_COVER: ["coverer", "damageShareRate", "guardRate", "appliesTo", "duration"],
  APPLY_REFLECT: ["reflectTo", "formula", "timing", "allowRecursiveReflect", "duration"],
  APPLY_SUBUNIT: ["durability", "additionalDamage"],
  COOLDOWN_MANIPULATION: ["targetSkillDefinitionId", "operation", "amount"],
};

const DAMAGE_CRITICAL_ALLOWED_KEYS = ["mode"] as const;
const DAMAGE_ACCURACY_ALLOWED_KEYS = ["mode"] as const;
const DAMAGE_PIERCING_ALLOWED_KEYS = [
  "defenseIgnoreRate",
  "shieldIgnoreRate",
  "damageReductionIgnoreRate",
] as const;
const LINK_ALLOWED_KEYS = ["enabled"] as const;
const TIMING_ALLOWED_KEYS = ["eventType", "targetSelector"] as const;
const STACKING_ALLOWED_KEYS = ["mode"] as const;
const BOUNDS_ALLOWED_KEYS = ["min", "max"] as const;
const APPLIES_TO_ACTION_KINDS_ALLOWED_KEYS = ["actionKinds"] as const;
const APPLIES_TO_INCOMING_ACTION_KINDS_ALLOWED_KEYS = ["incomingActionKinds"] as const;
const STACK_ALLOWED_KEYS = ["policy", "max"] as const;
const TRIGGER_LETHAL_ALLOWED_KEYS = ["lethalDamageOnly"] as const;
const SUBUNIT_FORMULA_HOLDER_ALLOWED_KEYS = ["formula"] as const;
const DAMAGE_THRESHOLD_ALLOWED_KEYS = ["op", "formula"] as const;

function requireField<T>(value: T | undefined, path: string): T {
  if (value === undefined) {
    throw new DomainValidationError(path, "is required");
  }
  return value;
}

function requireRate(value: number | undefined, path: string): number {
  const v = requireField(value, path);
  assertFinite(v, path);
  if (v < 0 || v > 1) {
    throw new DomainValidationError(path, `must be within [0, 1], got ${v}`);
  }
  return v;
}

function createFormulaField(
  payload: Record<string, unknown>,
  key: string,
  path: string,
): FormulaDefinition {
  const value = payload[key] as FormulaDefinitionInput | undefined;
  return createFormulaDefinition(
    requireField(value, `${path}.${key}`),
    `${path}.${key}`,
    undefined,
  );
}

function createDurationField(payload: Record<string, unknown>, path: string): DurationDefinition {
  const value = payload["duration"] as DurationDefinitionInput | undefined;
  return createDurationDefinition(
    requireField(value, `${path}.duration`),
    `${path}.duration`,
    undefined,
  );
}

function createActionKinds(
  value: readonly string[] | undefined,
  path: string,
): readonly ActionKind[] {
  assertNonEmptyArray(value ?? [], path);
  for (const [i, kind] of (value ?? []).entries()) {
    assertEnumValue(kind, ACTION_KINDS, `${path}[${i}]`);
  }
  return (value ?? []) as readonly ActionKind[];
}

function requireStackingMode(payload: Record<string, unknown>, path: string): "STACKABLE" {
  const stacking = requireField(
    payload["stacking"] as { mode?: string } | undefined,
    `${path}.stacking`,
  );
  assertKnownKeys(stacking, STACKING_ALLOWED_KEYS, `${path}.stacking`);
  const mode = requireField(stacking.mode, `${path}.stacking.mode`);
  assertEnumValue(mode, STACKING_MODES, `${path}.stacking.mode`);
  return mode;
}

function createAppliesTo(
  payload: Record<string, unknown>,
  path: string,
): { readonly actionKinds: readonly ActionKind[] } {
  const appliesTo = payload["appliesTo"] as { actionKinds?: readonly string[] } | undefined;
  const appliesToObj = requireField(appliesTo, `${path}.appliesTo`);
  assertKnownKeys(appliesToObj, APPLIES_TO_ACTION_KINDS_ALLOWED_KEYS, `${path}.appliesTo`);
  return {
    actionKinds: createActionKinds(appliesToObj.actionKinds, `${path}.appliesTo.actionKinds`),
  };
}

export function createEffectActionDefinition(
  input: EffectActionDefinitionInput,
  path: string,
): EffectActionDefinition {
  const effectActionDefinitionId = createEffectActionDefinitionId(
    input.effectActionDefinitionId,
    `${path}.effectActionDefinitionId`,
  );
  assertEnumValue(input.kind, EFFECT_ACTION_KINDS, `${path}.kind`);

  const payloadPath = `${path}.payload`;
  const payload = input.payload;
  const shape = createPayload(input.kind, payload, payloadPath);

  assertArray(input.requiredCapabilities, `${path}.requiredCapabilities`);
  const requiredCapabilities = input.requiredCapabilities.map((id, i) =>
    createCapabilityId(id, `${path}.requiredCapabilities[${i}]`),
  );
  const tags = input.metadata?.tags ?? [];

  return deepFreeze({
    ...shape,
    effectActionDefinitionId,
    requiredCapabilities,
    metadata: { tags },
  });
}

function createPayload(
  kind: EffectActionKind,
  payload: Record<string, unknown>,
  path: string,
): EffectActionPayload {
  assertKnownKeys(payload, PAYLOAD_ALLOWED_KEYS[kind], path);
  switch (kind) {
    case "DAMAGE": {
      const damageType = requireField(
        payload["damageType"] as string | undefined,
        `${path}.damageType`,
      );
      assertEnumValue(damageType, DAMAGE_TYPES, `${path}.damageType`);
      const hitCount = (payload["hitCount"] as number | undefined) ?? 1;
      assertInteger(hitCount, `${path}.hitCount`, { min: 1 });
      const criticalRaw = payload["critical"] as { mode?: string } | undefined;
      if (criticalRaw !== undefined) {
        assertKnownKeys(criticalRaw, DAMAGE_CRITICAL_ALLOWED_KEYS, `${path}.critical`);
      }
      const criticalMode = criticalRaw?.mode ?? "NORMAL";
      assertEnumValue(criticalMode, CRITICAL_MODES, `${path}.critical.mode`);
      const accuracyRaw = payload["accuracy"] as { mode?: string } | undefined;
      if (accuracyRaw !== undefined) {
        assertKnownKeys(accuracyRaw, DAMAGE_ACCURACY_ALLOWED_KEYS, `${path}.accuracy`);
      }
      const accuracyMode = accuracyRaw?.mode ?? "NORMAL";
      assertEnumValue(accuracyMode, ACCURACY_MODES, `${path}.accuracy.mode`);
      const piercingRaw = payload["piercing"] as
        | {
            defenseIgnoreRate?: number;
            shieldIgnoreRate?: number;
            damageReductionIgnoreRate?: number;
          }
        | undefined;
      if (piercingRaw !== undefined) {
        assertKnownKeys(piercingRaw, DAMAGE_PIERCING_ALLOWED_KEYS, `${path}.piercing`);
      }
      const piercing = piercingRaw ?? {};
      const defenseIgnoreRate = piercing.defenseIgnoreRate ?? 0;
      const shieldIgnoreRate = piercing.shieldIgnoreRate ?? 0;
      const damageReductionIgnoreRate = piercing.damageReductionIgnoreRate ?? 0;
      for (const [key, value] of Object.entries({
        defenseIgnoreRate,
        shieldIgnoreRate,
        damageReductionIgnoreRate,
      })) {
        assertFinite(value, `${path}.piercing.${key}`);
        if (value < 0 || value > 1) {
          throw new DomainValidationError(
            `${path}.piercing.${key}`,
            `must be within [0, 1], got ${value}`,
          );
        }
      }
      const damageModifiersRaw = payload["damageModifiers"];
      if (damageModifiersRaw !== undefined) {
        assertArray(damageModifiersRaw, `${path}.damageModifiers`);
      }
      const damageModifiersInput =
        (damageModifiersRaw as readonly FormulaDefinitionInput[] | undefined) ?? [];
      const linkRaw = payload["link"] as { enabled?: unknown } | undefined;
      if (linkRaw !== undefined) {
        assertKnownKeys(linkRaw, LINK_ALLOWED_KEYS, `${path}.link`);
      }
      let linkEnabled = false;
      if (linkRaw?.enabled !== undefined) {
        assertBoolean(linkRaw.enabled, `${path}.link.enabled`);
        linkEnabled = linkRaw.enabled;
      }
      return {
        kind: "DAMAGE",
        payload: {
          damageType,
          formula: createFormulaField(payload, "formula", path),
          hitCount,
          critical: { mode: criticalMode },
          accuracy: { mode: accuracyMode },
          piercing: { defenseIgnoreRate, shieldIgnoreRate, damageReductionIgnoreRate },
          damageModifiers: damageModifiersInput.map((f, i) =>
            createFormulaDefinition(f, `${path}.damageModifiers[${i}]`, undefined),
          ),
          link: { enabled: linkEnabled },
        },
      };
    }
    case "HEAL": {
      const overheal = (payload["overheal"] as string | undefined) ?? "DISCARD";
      assertEnumValue(overheal, OVERHEAL_POLICIES, `${path}.overheal`);
      return {
        kind: "HEAL",
        payload: {
          formula: createFormulaField(payload, "formula", path),
          overheal,
        },
      };
    }
    case "APPLY_CONTINUOUS_HEAL": {
      const timing = requireField(
        payload["timing"] as { eventType?: string; targetSelector?: string } | undefined,
        `${path}.timing`,
      );
      assertKnownKeys(timing, TIMING_ALLOWED_KEYS, `${path}.timing`);
      const eventType = requireField(timing.eventType, `${path}.timing.eventType`);
      const targetSelector = requireField(timing.targetSelector, `${path}.timing.targetSelector`);
      return {
        kind: "APPLY_CONTINUOUS_HEAL",
        payload: {
          formula: createFormulaField(payload, "formula", path),
          timing: { eventType, targetSelector },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_CONTINUOUS_DAMAGE": {
      const damageType = requireField(
        payload["damageType"] as string | undefined,
        `${path}.damageType`,
      );
      assertEnumValue(damageType, DAMAGE_TYPES, `${path}.damageType`);
      const timing = requireField(
        payload["timing"] as { eventType?: string; targetSelector?: string } | undefined,
        `${path}.timing`,
      );
      assertKnownKeys(timing, TIMING_ALLOWED_KEYS, `${path}.timing`);
      const eventType = requireField(timing.eventType, `${path}.timing.eventType`);
      const targetSelector = requireField(timing.targetSelector, `${path}.timing.targetSelector`);
      return {
        kind: "APPLY_CONTINUOUS_DAMAGE",
        payload: {
          damageType,
          formula: createFormulaField(payload, "formula", path),
          timing: { eventType, targetSelector },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_STAT_MOD": {
      const stat = requireField(payload["stat"] as string | undefined, `${path}.stat`);
      assertEnumValue(stat, STAT_KINDS, `${path}.stat`);
      const valueType = requireField(
        payload["valueType"] as string | undefined,
        `${path}.valueType`,
      );
      assertEnumValue(valueType, STAT_VALUE_TYPES, `${path}.valueType`);
      const stackingMode = requireStackingMode(payload, path);
      return {
        kind: "APPLY_STAT_MOD",
        payload: {
          stat,
          valueType,
          formula: createFormulaField(payload, "formula", path),
          stacking: { mode: stackingMode },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_DAMAGE_MOD": {
      const direction = requireField(
        payload["direction"] as string | undefined,
        `${path}.direction`,
      );
      assertEnumValue(direction, DAMAGE_MOD_DIRECTIONS, `${path}.direction`);
      const damageTypeRaw = payload["damageType"] as string | null | undefined;
      let damageType: DamageType | null = null;
      if (damageTypeRaw !== undefined && damageTypeRaw !== null) {
        assertEnumValue(damageTypeRaw, DAMAGE_TYPES, `${path}.damageType`);
        damageType = damageTypeRaw;
      }
      const stackingMode = requireStackingMode(payload, path);
      return {
        kind: "APPLY_DAMAGE_MOD",
        payload: {
          direction,
          damageType,
          formula: createFormulaField(payload, "formula", path),
          stacking: { mode: stackingMode },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_HEALING_MOD": {
      const direction = requireField(
        payload["direction"] as string | undefined,
        `${path}.direction`,
      );
      assertEnumValue(direction, DAMAGE_MOD_DIRECTIONS, `${path}.direction`);
      const stackingMode = requireStackingMode(payload, path);
      return {
        kind: "APPLY_HEALING_MOD",
        payload: {
          direction,
          formula: createFormulaField(payload, "formula", path),
          stacking: { mode: stackingMode },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "MODIFY_RESOURCE": {
      const resource = requireField(payload["resource"] as string | undefined, `${path}.resource`);
      assertEnumValue(resource, RESOURCE_KINDS, `${path}.resource`);
      const operation = requireField(
        payload["operation"] as string | undefined,
        `${path}.operation`,
      );
      assertEnumValue(operation, RESOURCE_OPERATIONS, `${path}.operation`);
      const boundsInput = payload["bounds"] as
        | { min?: number; max?: number | "CURRENT_MAX" }
        | undefined;
      const result: {
        resource: ResourceKind;
        operation: ResourceModifyOperation;
        formula: FormulaDefinition;
        bounds?: { min: number; max: number | "CURRENT_MAX" };
      } = {
        resource,
        operation,
        formula: createFormulaField(payload, "formula", path),
      };
      if (boundsInput !== undefined) {
        assertKnownKeys(boundsInput, BOUNDS_ALLOWED_KEYS, `${path}.bounds`);
        const min = requireField(boundsInput.min, `${path}.bounds.min`);
        assertFinite(min, `${path}.bounds.min`);
        const max = requireField(boundsInput.max, `${path}.bounds.max`);
        if (max !== "CURRENT_MAX") {
          assertFinite(max, `${path}.bounds.max`);
        }
        result.bounds = { min, max };
      }
      return { kind: "MODIFY_RESOURCE", payload: result };
    }
    case "MODIFY_RESOURCE_CAPACITY": {
      const resource = requireField(payload["resource"] as string | undefined, `${path}.resource`);
      assertEnumValue(resource, RESOURCE_KINDS, `${path}.resource`);
      const operation = requireField(
        payload["operation"] as string | undefined,
        `${path}.operation`,
      );
      assertEnumValue(operation, RESOURCE_CAPACITY_OPERATIONS, `${path}.operation`);
      return {
        kind: "MODIFY_RESOURCE_CAPACITY",
        payload: {
          resource,
          operation,
          formula: createFormulaField(payload, "formula", path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_STATUS": {
      const status = requireField(payload["status"] as string | undefined, `${path}.status`);
      assertEnumValue(status, STATUS_KINDS, `${path}.status`);
      const result: {
        status: (typeof STATUS_KINDS)[number];
        duration: DurationDefinition;
        probability?: number;
        appliesTo?: { incomingActionKinds: readonly ActionKind[] };
        damageAmplificationOnBreak?: number;
        damageThreshold?: DamageThreshold;
      } = {
        status,
        duration: createDurationField(payload, path),
      };
      const probability = payload["probability"] as number | undefined;
      if (probability !== undefined) {
        assertFinite(probability, `${path}.probability`);
        if (probability < 0 || probability > 1) {
          throw new DomainValidationError(
            `${path}.probability`,
            `must be within [0, 1], got ${probability}`,
          );
        }
        result.probability = probability;
      }
      const appliesTo = payload["appliesTo"] as
        | { incomingActionKinds?: readonly string[] }
        | undefined;
      if (appliesTo !== undefined) {
        assertKnownKeys(
          appliesTo,
          APPLIES_TO_INCOMING_ACTION_KINDS_ALLOWED_KEYS,
          `${path}.appliesTo`,
        );
        result.appliesTo = {
          incomingActionKinds: createActionKinds(
            appliesTo.incomingActionKinds,
            `${path}.appliesTo.incomingActionKinds`,
          ),
        };
      }
      const damageAmplificationOnBreak = payload["damageAmplificationOnBreak"] as
        | number
        | undefined;
      if (damageAmplificationOnBreak !== undefined) {
        assertFinite(damageAmplificationOnBreak, `${path}.damageAmplificationOnBreak`);
        result.damageAmplificationOnBreak = damageAmplificationOnBreak;
      }
      const damageThresholdRaw = payload["damageThreshold"] as
        | { op?: string; formula?: FormulaDefinitionInput }
        | undefined;
      if (damageThresholdRaw !== undefined) {
        if (status !== "DAMAGE_IMMUNITY") {
          throw new DomainValidationError(
            `${path}.damageThreshold`,
            `is only meaningful when status is "DAMAGE_IMMUNITY", got "${status}"`,
          );
        }
        assertKnownKeys(
          damageThresholdRaw,
          DAMAGE_THRESHOLD_ALLOWED_KEYS,
          `${path}.damageThreshold`,
        );
        const op = requireField(damageThresholdRaw.op, `${path}.damageThreshold.op`);
        assertEnumValue(op, COMPARISON_OPERATORS, `${path}.damageThreshold.op`);
        result.damageThreshold = {
          op,
          formula: createFormulaField(damageThresholdRaw, "formula", `${path}.damageThreshold`),
        };
      }
      return { kind: "APPLY_STATUS", payload: result };
    }
    case "APPLY_SHIELD": {
      return {
        kind: "APPLY_SHIELD",
        payload: {
          formula: createFormulaField(payload, "formula", path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "REMOVE_EFFECTS": {
      const categories = payload["categories"] as readonly string[] | undefined;
      assertNonEmptyArray(categories ?? [], `${path}.categories`);
      for (const [i, category] of (categories ?? []).entries()) {
        assertEnumValue(category, EFFECT_IMMUNITY_CATEGORIES, `${path}.categories[${i}]`);
      }
      const typedCategories = (categories ?? []) as readonly EffectImmunityCategory[];
      const result: RemoveEffectsPayload = { categories: typedCategories };
      if (typedCategories.includes("SPECIFIC_EFFECT")) {
        const ids = payload["effectActionDefinitionIds"] as readonly string[] | undefined;
        assertNonEmptyArray(ids ?? [], `${path}.effectActionDefinitionIds`);
        return {
          kind: "REMOVE_EFFECTS",
          payload: {
            ...result,
            effectActionDefinitionIds: (ids ?? []).map((id, i) =>
              createEffectActionDefinitionId(id, `${path}.effectActionDefinitionIds[${i}]`),
            ),
          },
        };
      }
      if (payload["effectActionDefinitionIds"] !== undefined) {
        throw new DomainValidationError(
          `${path}.effectActionDefinitionIds`,
          'must not be set when "categories" does not include "SPECIFIC_EFFECT" (it would otherwise be silently ignored)',
        );
      }
      return { kind: "REMOVE_EFFECTS", payload: result };
    }
    case "EFFECT_IMMUNITY": {
      const categories = payload["categories"] as readonly string[] | undefined;
      assertNonEmptyArray(categories ?? [], `${path}.categories`);
      for (const [i, category] of (categories ?? []).entries()) {
        assertEnumValue(category, EFFECT_IMMUNITY_CATEGORIES, `${path}.categories[${i}]`);
      }
      const typedCategories = (categories ?? []) as readonly EffectImmunityCategory[];
      const maxBlocksRaw = payload["maxBlocks"];
      if (maxBlocksRaw === undefined) {
        throw new DomainValidationError(`${path}.maxBlocks`, "is required");
      }
      assertNullableInteger(maxBlocksRaw, `${path}.maxBlocks`, { min: 1 });
      const result: {
        categories: readonly EffectImmunityCategory[];
        effectActionDefinitionIds?: readonly EffectActionDefinitionId[];
        duration: DurationDefinition;
        maxBlocks: number | null;
      } = {
        categories: typedCategories,
        duration: createDurationField(payload, path),
        maxBlocks: maxBlocksRaw,
      };
      if (typedCategories.includes("SPECIFIC_EFFECT")) {
        const ids = payload["effectActionDefinitionIds"] as readonly string[] | undefined;
        assertNonEmptyArray(ids ?? [], `${path}.effectActionDefinitionIds`);
        result.effectActionDefinitionIds = (ids ?? []).map((id, i) =>
          createEffectActionDefinitionId(id, `${path}.effectActionDefinitionIds[${i}]`),
        );
      }
      return { kind: "EFFECT_IMMUNITY", payload: result };
    }
    case "APPLY_MARKER": {
      const markerId = createMarkerId(
        requireField(payload["markerId"] as string | undefined, `${path}.markerId`),
        `${path}.markerId`,
      );
      const stackInput = requireField(
        payload["stack"] as { policy?: string; max?: number | null } | undefined,
        `${path}.stack`,
      );
      assertKnownKeys(stackInput, STACK_ALLOWED_KEYS, `${path}.stack`);
      const policy = requireField(stackInput.policy, `${path}.stack.policy`);
      assertEnumValue(policy, MARKER_STACK_POLICIES, `${path}.stack.policy`);
      if (stackInput.max !== undefined) {
        assertNullableInteger(stackInput.max, `${path}.stack.max`, { min: 1 });
      }
      return {
        kind: "APPLY_MARKER",
        payload: {
          markerId,
          stack: { policy, max: stackInput.max ?? null },
          duration: createDurationField(payload, path),
        },
      };
    }
    case "REMOVE_MARKER": {
      const markerId = createMarkerId(
        requireField(payload["markerId"] as string | undefined, `${path}.markerId`),
        `${path}.markerId`,
      );
      return { kind: "REMOVE_MARKER", payload: { markerId } };
    }
    case "APPLY_DEATH_SURVIVAL": {
      const trigger = requireField(
        payload["trigger"] as { lethalDamageOnly?: boolean } | undefined,
        `${path}.trigger`,
      );
      assertKnownKeys(trigger, TRIGGER_LETHAL_ALLOWED_KEYS, `${path}.trigger`);
      const lethalDamageOnly = requireField(
        trigger.lethalDamageOnly,
        `${path}.trigger.lethalDamageOnly`,
      );
      assertBoolean(lethalDamageOnly, `${path}.trigger.lethalDamageOnly`);
      const healAfterSurvivalInput = payload["healAfterSurvival"] as
        | FormulaDefinitionInput
        | null
        | undefined;
      return {
        kind: "APPLY_DEATH_SURVIVAL",
        payload: {
          trigger: { lethalDamageOnly },
          survivalHp: createFormulaField(payload, "survivalHp", path),
          healAfterSurvival:
            healAfterSurvivalInput === undefined || healAfterSurvivalInput === null
              ? null
              : createFormulaDefinition(
                  healAfterSurvivalInput,
                  `${path}.healAfterSurvival`,
                  undefined,
                ),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_TARGET_REDIRECT": {
      const redirectTo = requireField(
        payload["redirectTo"] as TargetReferenceInput | undefined,
        `${path}.redirectTo`,
      );
      return {
        kind: "APPLY_TARGET_REDIRECT",
        payload: {
          redirectTo: createTargetReference(redirectTo, `${path}.redirectTo`, undefined),
          appliesTo: createAppliesTo(payload, path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_COVER": {
      const coverer = requireField(
        payload["coverer"] as TargetReferenceInput | undefined,
        `${path}.coverer`,
      );
      return {
        kind: "APPLY_COVER",
        payload: {
          coverer: createTargetReference(coverer, `${path}.coverer`, undefined),
          damageShareRate: requireRate(
            payload["damageShareRate"] as number | undefined,
            `${path}.damageShareRate`,
          ),
          guardRate: requireRate(payload["guardRate"] as number | undefined, `${path}.guardRate`),
          appliesTo: createAppliesTo(payload, path),
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_REFLECT": {
      const reflectTo = requireField(
        payload["reflectTo"] as TargetReferenceInput | undefined,
        `${path}.reflectTo`,
      );
      const timing = requireField(payload["timing"] as string | undefined, `${path}.timing`);
      assertEnumValue(timing, REFLECT_TIMINGS, `${path}.timing`);
      const allowRecursiveReflectRaw = payload["allowRecursiveReflect"];
      let allowRecursiveReflect = false;
      if (allowRecursiveReflectRaw !== undefined) {
        assertBoolean(allowRecursiveReflectRaw, `${path}.allowRecursiveReflect`);
        allowRecursiveReflect = allowRecursiveReflectRaw;
      }
      return {
        kind: "APPLY_REFLECT",
        payload: {
          reflectTo: createTargetReference(reflectTo, `${path}.reflectTo`, undefined),
          formula: createFormulaField(payload, "formula", path),
          timing,
          allowRecursiveReflect,
          duration: createDurationField(payload, path),
        },
      };
    }
    case "APPLY_SUBUNIT": {
      const durability = requireField(
        payload["durability"] as { formula?: FormulaDefinitionInput } | undefined,
        `${path}.durability`,
      );
      const additionalDamage = requireField(
        payload["additionalDamage"] as { formula?: FormulaDefinitionInput } | undefined,
        `${path}.additionalDamage`,
      );
      assertKnownKeys(durability, SUBUNIT_FORMULA_HOLDER_ALLOWED_KEYS, `${path}.durability`);
      assertKnownKeys(
        additionalDamage,
        SUBUNIT_FORMULA_HOLDER_ALLOWED_KEYS,
        `${path}.additionalDamage`,
      );
      const durabilityFormula = requireField(durability.formula, `${path}.durability.formula`);
      const additionalDamageFormula = requireField(
        additionalDamage.formula,
        `${path}.additionalDamage.formula`,
      );
      return {
        kind: "APPLY_SUBUNIT",
        payload: {
          durability: {
            formula: createFormulaDefinition(
              durabilityFormula,
              `${path}.durability.formula`,
              undefined,
            ),
          },
          additionalDamage: {
            formula: createFormulaDefinition(
              additionalDamageFormula,
              `${path}.additionalDamage.formula`,
              undefined,
            ),
          },
        },
      };
    }
    case "COOLDOWN_MANIPULATION": {
      const targetSkillDefinitionId = createSkillDefinitionId(
        requireField(
          payload["targetSkillDefinitionId"] as string | undefined,
          `${path}.targetSkillDefinitionId`,
        ),
        `${path}.targetSkillDefinitionId`,
      );
      const operation = requireField(
        payload["operation"] as string | undefined,
        `${path}.operation`,
      );
      assertEnumValue(operation, COOLDOWN_MANIPULATION_OPERATIONS, `${path}.operation`);
      if (operation === "REDUCE") {
        const amount = requireField(payload["amount"] as number | undefined, `${path}.amount`);
        assertInteger(amount, `${path}.amount`, { min: 1 });
        return {
          kind: "COOLDOWN_MANIPULATION",
          payload: {
            targetSkillDefinitionId,
            operation,
            amount,
          },
        };
      }
      return {
        kind: "COOLDOWN_MANIPULATION",
        payload: {
          targetSkillDefinitionId,
          operation,
        },
      };
    }
  }
}
