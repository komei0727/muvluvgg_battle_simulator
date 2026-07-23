import type { ResourceKind, SkillType } from "./catalog-enums.js";
import {
  createCapabilityId,
  createSkillDefinitionId,
  type CapabilityId,
  type SkillDefinitionId,
} from "./catalog-ids.js";
import {
  createConditionDefinition,
  type ConditionDefinition,
  type ConditionDefinitionInput,
} from "./condition-definition.js";
import {
  createEffectSequence,
  type EffectSequence,
  type EffectSequenceInput,
} from "./effect-sequence.js";
import {
  createTriggerDefinition,
  type TriggerDefinition,
  type TriggerDefinitionInput,
} from "./trigger-definition.js";
import {
  createRuntimeCounterUpdateDefinition,
  type RuntimeCounterUpdateDefinition,
  type RuntimeCounterUpdateDefinitionInput,
} from "./runtime-counter-update-definition.js";
import type { RuntimeCounterId } from "./catalog-ids.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertArray,
  assertBoolean,
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertKnownKeys,
} from "../../shared/validate.js";

const SKILL_TYPES = ["AS", "PS", "EX"] as const;
const RESOURCE_KINDS = ["AP", "PP", "EX_GAUGE"] as const;
const COOLDOWN_UNITS = ["ACTION", "TURN"] as const;
const TRAITS_ALLOWED_KEYS = [
  "priorityAttack",
  "simultaneousActivationLimited",
  "exclusiveActivationGroupId",
  "accuracy",
  "piercing",
] as const;
const TRAITS_ACCURACY_ALLOWED_KEYS = ["guaranteedHit"] as const;
const TRAITS_PIERCING_ALLOWED_KEYS = [
  "defenseIgnoreRate",
  "shieldIgnoreRate",
  "damageReductionIgnoreRate",
] as const;
export type CooldownUnit = (typeof COOLDOWN_UNITS)[number];

/** `05_ドメインモデル.md`: AS費消はAP、PSはPP、EXはEX_GAUGEで固定される。 */
const RESOURCE_BY_SKILL_TYPE: Record<SkillType, ResourceKind> = {
  AS: "AP",
  PS: "PP",
  EX: "EX_GAUGE",
};

export interface SkillCost {
  readonly resource: ResourceKind;
  readonly amount: number;
}

export interface SkillTraits {
  readonly priorityAttack: boolean;
  readonly simultaneousActivationLimited: boolean;
  readonly exclusiveActivationGroupId: string | null;
  readonly accuracy: { readonly guaranteedHit: boolean };
  readonly piercing: {
    readonly defenseIgnoreRate: number;
    readonly shieldIgnoreRate: number;
    readonly damageReductionIgnoreRate: number;
  };
}

export interface Cooldown {
  readonly unit: CooldownUnit;
  readonly count: number;
}

export type SkillResolutionDefinition =
  | ({ readonly kind: "IMMEDIATE" } & EffectSequence)
  | ({ readonly kind: "CHARGE"; readonly chargeRelease: EffectSequence } & EffectSequence);

export interface SkillDefinition {
  readonly skillDefinitionId: SkillDefinitionId;
  readonly skillType: SkillType;
  readonly cost: SkillCost;
  readonly activationCondition: ConditionDefinition;
  readonly triggers: readonly TriggerDefinition[];
  readonly counterUpdates: readonly RuntimeCounterUpdateDefinition[];
  readonly resolution: SkillResolutionDefinition;
  readonly cooldown: Cooldown;
  readonly traits: SkillTraits;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly metadata: { readonly displayName: string; readonly tags: readonly string[] };
}

export interface SkillCostInput {
  readonly resource: string;
  readonly amount: number;
}

export interface SkillTraitsInput {
  readonly priorityAttack?: boolean;
  readonly simultaneousActivationLimited?: boolean;
  readonly exclusiveActivationGroupId?: string | null;
  readonly accuracy?: { readonly guaranteedHit?: boolean };
  readonly piercing?: {
    readonly defenseIgnoreRate?: number;
    readonly shieldIgnoreRate?: number;
    readonly damageReductionIgnoreRate?: number;
  };
}

export interface CooldownInput {
  readonly unit: string;
  readonly count: number;
}

export interface SkillResolutionDefinitionInput {
  readonly kind: string;
  readonly targetBindings?: EffectSequenceInput["targetBindings"];
  readonly steps: EffectSequenceInput["steps"];
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」`EffectSequence`スコープ（EFF-006、
   * Issue #212）。`SkillDefinition.counterUpdates`（`SKILL_RUNTIME`スコープ）とは
   * 独立に、この解決（IMMEDIATE、またはCHARGEの開始側）自身のEffectSequenceが
   * 宣言するcounterUpdatesを渡す。`chargeRelease`側は`EffectSequenceInput`を
   * そのまま渡すため、既に`counterUpdates`を宣言できる。
   */
  readonly counterUpdates?: EffectSequenceInput["counterUpdates"];
  readonly chargeRelease?: EffectSequenceInput;
}

export interface SkillDefinitionInput {
  readonly skillDefinitionId: string;
  readonly skillType: string;
  readonly cost: SkillCostInput;
  readonly activationCondition?: ConditionDefinitionInput;
  readonly triggers?: readonly TriggerDefinitionInput[];
  readonly counterUpdates?: readonly RuntimeCounterUpdateDefinitionInput[];
  readonly resolution: SkillResolutionDefinitionInput;
  readonly cooldown: CooldownInput;
  readonly traits: SkillTraitsInput;
  readonly requiredCapabilities: readonly string[];
  readonly metadata: { readonly displayName: string; readonly tags?: readonly string[] };
}

function createCost(input: SkillCostInput, skillType: SkillType, path: string): SkillCost {
  assertEnumValue(input.resource, RESOURCE_KINDS, `${path}.resource`);
  const expected = RESOURCE_BY_SKILL_TYPE[skillType];
  if (input.resource !== expected) {
    throw new DomainValidationError(
      `${path}.resource`,
      `must be "${expected}" for skillType "${skillType}", got "${input.resource}"`,
    );
  }
  // R-ACT-03: AS・PS・EXいずれもコスト0は存在しない。EXはUnitのextraGaugeMaximum
  // （既に1以上を要求）と一致必須のため、この下限と矛盾しない。
  assertInteger(input.amount, `${path}.amount`, { min: 1 });
  return { resource: input.resource, amount: input.amount };
}

function createTraits(input: SkillTraitsInput, path: string): SkillTraits {
  assertKnownKeys(input, TRAITS_ALLOWED_KEYS, path);
  if (input.accuracy !== undefined) {
    assertKnownKeys(input.accuracy, TRAITS_ACCURACY_ALLOWED_KEYS, `${path}.accuracy`);
  }
  if (input.piercing !== undefined) {
    assertKnownKeys(input.piercing, TRAITS_PIERCING_ALLOWED_KEYS, `${path}.piercing`);
  }
  const piercing = input.piercing ?? {};
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
  let priorityAttack = false;
  if (input.priorityAttack !== undefined) {
    assertBoolean(input.priorityAttack, `${path}.priorityAttack`);
    priorityAttack = input.priorityAttack;
  }

  let simultaneousActivationLimited = false;
  if (input.simultaneousActivationLimited !== undefined) {
    assertBoolean(input.simultaneousActivationLimited, `${path}.simultaneousActivationLimited`);
    simultaneousActivationLimited = input.simultaneousActivationLimited;
  }

  if (input.exclusiveActivationGroupId !== undefined && input.exclusiveActivationGroupId !== null) {
    if (typeof input.exclusiveActivationGroupId !== "string") {
      throw new DomainValidationError(
        `${path}.exclusiveActivationGroupId`,
        `must be a string or null, got ${typeof input.exclusiveActivationGroupId}`,
      );
    }
  }

  let guaranteedHit = false;
  if (input.accuracy?.guaranteedHit !== undefined) {
    assertBoolean(input.accuracy.guaranteedHit, `${path}.accuracy.guaranteedHit`);
    guaranteedHit = input.accuracy.guaranteedHit;
  }

  return {
    priorityAttack,
    simultaneousActivationLimited,
    exclusiveActivationGroupId: input.exclusiveActivationGroupId ?? null,
    accuracy: { guaranteedHit },
    piercing: { defenseIgnoreRate, shieldIgnoreRate, damageReductionIgnoreRate },
  };
}

function createCooldown(input: CooldownInput, path: string): Cooldown {
  assertEnumValue(input.unit, COOLDOWN_UNITS, `${path}.unit`);
  assertInteger(input.count, `${path}.count`, { min: 0 });
  return { unit: input.unit, count: input.count };
}

function createSequenceInput(input: SkillResolutionDefinitionInput): EffectSequenceInput {
  return {
    ...(input.targetBindings === undefined ? {} : { targetBindings: input.targetBindings }),
    steps: input.steps,
    ...(input.counterUpdates === undefined ? {} : { counterUpdates: input.counterUpdates }),
  };
}

function createResolution(
  input: SkillResolutionDefinitionInput,
  path: string,
): SkillResolutionDefinition {
  if (input.kind === "IMMEDIATE") {
    const sequence = createEffectSequence(createSequenceInput(input), path);
    return { kind: "IMMEDIATE", ...sequence };
  }
  if (input.kind === "CHARGE") {
    const sequence = createEffectSequence(createSequenceInput(input), path);
    if (input.chargeRelease === undefined) {
      throw new DomainValidationError(`${path}.chargeRelease`, "is required when kind is CHARGE");
    }
    const chargeRelease = createEffectSequence(input.chargeRelease, `${path}.chargeRelease`);
    return { kind: "CHARGE", ...sequence, chargeRelease };
  }
  throw new DomainValidationError(
    `${path}.kind`,
    `must be one of [IMMEDIATE, CHARGE], got "${input.kind}"`,
  );
}

/**
 * `RUNTIME_COUNTER` Conditionが参照するcounterは、`R-EFF-11`の所有範囲規則
 * （M6最小実装、Issue #143）により、同じSkillDefinitionが宣言する
 * `counterUpdates`に存在するものだけを許可する。AND/OR/NOTを再帰的に辿る。
 */
function collectReferencedRuntimeCounterIds(
  condition: ConditionDefinition,
  into: Set<RuntimeCounterId>,
): void {
  switch (condition.kind) {
    case "AND":
    case "OR":
      condition.conditions.forEach((c) => collectReferencedRuntimeCounterIds(c, into));
      return;
    case "NOT":
      collectReferencedRuntimeCounterIds(condition.condition, into);
      return;
    case "RUNTIME_COUNTER":
      into.add(condition.counter);
      return;
    default:
      return;
  }
}

/**
 * `RUNTIME_COUNTER`参照は、同じSkillDefinitionの`counterUpdates`が更新契機を
 * 明示しなければならない。production Catalogに残っていた暗黙counterはIssue #166で
 * 明示定義へ移行済みであり、更新契機のない参照を再導入させない。
 */
function assertRuntimeCounterReferencesAreDeclared(
  activationCondition: ConditionDefinition,
  triggers: readonly TriggerDefinition[],
  counterUpdates: readonly RuntimeCounterUpdateDefinition[],
  path: string,
): void {
  const declared = new Set(counterUpdates.map((update) => update.counter));
  const referenced = new Set<RuntimeCounterId>();
  collectReferencedRuntimeCounterIds(activationCondition, referenced);
  triggers.forEach((trigger) => collectReferencedRuntimeCounterIds(trigger.condition, referenced));
  for (const counter of referenced) {
    if (!declared.has(counter)) {
      throw new DomainValidationError(
        `${path}.counterUpdates`,
        `RUNTIME_COUNTER references undeclared counter "${counter}" (must appear in counterUpdates)`,
      );
    }
  }
}

export function createSkillDefinition(
  input: SkillDefinitionInput,
  path = "skill",
): SkillDefinition {
  const skillDefinitionId = createSkillDefinitionId(
    input.skillDefinitionId,
    `${path}.skillDefinitionId`,
  );
  assertEnumValue(input.skillType, SKILL_TYPES, `${path}.skillType`);

  if (input.triggers !== undefined) {
    assertArray(input.triggers, `${path}.triggers`);
  }
  const triggers = (input.triggers ?? []).map((t, i) =>
    createTriggerDefinition(t, `${path}.triggers[${i}]`),
  );
  if (input.skillType === "PS") {
    if (triggers.length === 0) {
      throw new DomainValidationError(
        `${path}.triggers`,
        "PS skills must declare at least one trigger",
      );
    }
  } else if (triggers.length > 0) {
    throw new DomainValidationError(
      `${path}.triggers`,
      `${input.skillType} skills must not declare triggers`,
    );
  }

  assertArray(input.requiredCapabilities, `${path}.requiredCapabilities`);
  const requiredCapabilities = input.requiredCapabilities.map((id, i) =>
    createCapabilityId(id, `${path}.requiredCapabilities[${i}]`),
  );

  const activationCondition =
    input.activationCondition === undefined
      ? { kind: "TRUE" as const }
      : createConditionDefinition(
          input.activationCondition,
          `${path}.activationCondition`,
          undefined,
        );

  if (input.counterUpdates !== undefined) {
    assertArray(input.counterUpdates, `${path}.counterUpdates`);
  }
  const counterUpdates = (input.counterUpdates ?? []).map((c, i) =>
    createRuntimeCounterUpdateDefinition(c, `${path}.counterUpdates[${i}]`),
  );
  assertRuntimeCounterReferencesAreDeclared(activationCondition, triggers, counterUpdates, path);

  return deepFreeze({
    skillDefinitionId,
    skillType: input.skillType,
    cost: createCost(input.cost, input.skillType, `${path}.cost`),
    activationCondition,
    triggers,
    counterUpdates,
    resolution: createResolution(input.resolution, `${path}.resolution`),
    cooldown: createCooldown(input.cooldown, `${path}.cooldown`),
    traits: createTraits(input.traits, `${path}.traits`),
    requiredCapabilities,
    metadata: { displayName: input.metadata.displayName, tags: input.metadata.tags ?? [] },
  });
}
