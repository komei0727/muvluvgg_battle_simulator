import {
  createCapabilityId,
  createMemoryDefinitionId,
  type CapabilityId,
  type MemoryDefinitionId,
} from "./catalog-ids.js";
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
import { deepFreeze } from "../shared/deep-freeze.js";
import { DomainValidationError } from "../shared/errors.js";
import { assertArray, assertEnumValue, assertFinite } from "../shared/validate.js";

const MODIFIER_STATS = [
  "MAXIMUM_HP",
  "ATTACK",
  "DEFENSE",
  "CRITICAL_RATE",
  "ACTION_SPEED",
  "CRITICAL_DAMAGE_BONUS",
] as const;
export type ModifierStat = (typeof MODIFIER_STATS)[number];
const MODIFIER_VALUE_TYPES = ["FIXED", "RATIO"] as const;

export interface TriggeredEffect {
  readonly trigger: TriggerDefinition;
  readonly effectSequence: EffectSequence;
}

export interface TriggeredEffectInput {
  readonly trigger: TriggerDefinitionInput;
  readonly effectSequence: EffectSequenceInput;
}

/**
 * The shorthand covers only `ALLY` targets, `BattleStarted` timing, and
 * `BATTLE`-duration effects (`14_Catalog定義スキーマ.md` の modifiers省略記法) —
 * those constraints are implicit and not modeled as fields here.
 */
export interface MemoryModifier {
  readonly targetFilter: { readonly kind: "ALL" };
  readonly stat: ModifierStat;
  readonly valueType: (typeof MODIFIER_VALUE_TYPES)[number];
  readonly value: number;
}

export interface MemoryModifierInput {
  readonly targetFilter: { readonly kind: string };
  readonly stat: string;
  readonly valueType: string;
  readonly value: number;
}

export interface MemoryDefinition {
  readonly memoryDefinitionId: MemoryDefinitionId;
  readonly triggeredEffects: readonly TriggeredEffect[];
  readonly modifiers: readonly MemoryModifier[];
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly metadata: { readonly displayName: string; readonly tags: readonly string[] };
}

export interface MemoryDefinitionInput {
  readonly memoryDefinitionId: string;
  readonly triggeredEffects?: readonly TriggeredEffectInput[];
  readonly modifiers?: readonly MemoryModifierInput[];
  readonly requiredCapabilities: readonly string[];
  readonly metadata: { readonly displayName: string; readonly tags?: readonly string[] };
}

function createModifier(input: MemoryModifierInput, path: string): MemoryModifier {
  assertEnumValue(input.targetFilter.kind, ["ALL"], `${path}.targetFilter.kind`);
  assertEnumValue(input.stat, MODIFIER_STATS, `${path}.stat`);
  assertEnumValue(input.valueType, MODIFIER_VALUE_TYPES, `${path}.valueType`);
  assertFinite(input.value, `${path}.value`);
  return {
    targetFilter: { kind: "ALL" },
    stat: input.stat,
    valueType: input.valueType,
    value: input.value,
  };
}

export function createMemoryDefinition(
  input: MemoryDefinitionInput,
  path = "memory",
): MemoryDefinition {
  const memoryDefinitionId = createMemoryDefinitionId(
    input.memoryDefinitionId,
    `${path}.memoryDefinitionId`,
  );

  if (input.triggeredEffects !== undefined) {
    assertArray(input.triggeredEffects, `${path}.triggeredEffects`);
  }
  const triggeredEffects = (input.triggeredEffects ?? []).map((te, i) => ({
    trigger: createTriggerDefinition(te.trigger, `${path}.triggeredEffects[${i}].trigger`),
    effectSequence: createEffectSequence(
      te.effectSequence,
      `${path}.triggeredEffects[${i}].effectSequence`,
    ),
  }));
  if (input.modifiers !== undefined) {
    assertArray(input.modifiers, `${path}.modifiers`);
  }
  const modifiers = (input.modifiers ?? []).map((m, i) =>
    createModifier(m, `${path}.modifiers[${i}]`),
  );

  if (triggeredEffects.length === 0 && modifiers.length === 0) {
    throw new DomainValidationError(
      path,
      "must declare at least one of triggeredEffects or modifiers",
    );
  }

  assertArray(input.requiredCapabilities, `${path}.requiredCapabilities`);
  const requiredCapabilities = input.requiredCapabilities.map((id, i) =>
    createCapabilityId(id, `${path}.requiredCapabilities[${i}]`),
  );

  return deepFreeze({
    memoryDefinitionId,
    triggeredEffects,
    modifiers,
    requiredCapabilities,
    metadata: { displayName: input.metadata.displayName, tags: input.metadata.tags ?? [] },
  });
}
