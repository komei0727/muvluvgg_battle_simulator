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
import { deepFreeze } from "../../shared/deep-freeze.js";
import { DomainValidationError } from "../../shared/errors.js";
import { assertArray, assertKnownKeys } from "../../shared/validate.js";

const TRIGGERED_EFFECT_ALLOWED_KEYS = ["trigger", "effectSequence"] as const;

export interface TriggeredEffect {
  readonly trigger: TriggerDefinition;
  readonly effectSequence: EffectSequence;
}

export interface TriggeredEffectInput {
  readonly trigger: TriggerDefinitionInput;
  readonly effectSequence: EffectSequenceInput;
}

export interface MemoryDefinition {
  readonly memoryDefinitionId: MemoryDefinitionId;
  readonly triggeredEffects: readonly TriggeredEffect[];
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly metadata: { readonly displayName: string; readonly tags: readonly string[] };
}

export interface MemoryDefinitionInput {
  readonly memoryDefinitionId: string;
  readonly triggeredEffects?: readonly TriggeredEffectInput[];
  readonly requiredCapabilities: readonly string[];
  readonly metadata: { readonly displayName: string; readonly tags?: readonly string[] };
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
  const triggeredEffects = (input.triggeredEffects ?? []).map((te, i) => {
    assertKnownKeys(te, TRIGGERED_EFFECT_ALLOWED_KEYS, `${path}.triggeredEffects[${i}]`);
    return {
      trigger: createTriggerDefinition(te.trigger, `${path}.triggeredEffects[${i}].trigger`),
      effectSequence: createEffectSequence(
        te.effectSequence,
        `${path}.triggeredEffects[${i}].effectSequence`,
      ),
    };
  });
  if (triggeredEffects.length === 0) {
    throw new DomainValidationError(path, "must declare at least one triggeredEffect");
  }

  assertArray(input.requiredCapabilities, `${path}.requiredCapabilities`);
  const requiredCapabilities = input.requiredCapabilities.map((id, i) =>
    createCapabilityId(id, `${path}.requiredCapabilities[${i}]`),
  );

  return deepFreeze({
    memoryDefinitionId,
    triggeredEffects,
    requiredCapabilities,
    metadata: { displayName: input.metadata.displayName, tags: input.metadata.tags ?? [] },
  });
}
