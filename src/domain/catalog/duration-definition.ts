import type { DurationOwner, DurationTimeUnit, ConsumptionKind } from "./catalog-enums.js";
import {
  createConditionDefinition,
  type ConditionDefinition,
  type ConditionDefinitionInput,
} from "./condition-definition.js";
import type { TargetBindingScope } from "./references.js";
import { DomainValidationError } from "../shared/errors.js";
import {
  assertArray,
  assertBoolean,
  assertEnumValue,
  assertInteger,
  assertKnownKeys,
} from "../shared/validate.js";

const DURATION_ALLOWED_KEYS = [
  "timeLimit",
  "consumption",
  "expiration",
  "dispellable",
  "linkedEffectGroupId",
] as const;
const TIME_LIMIT_ALLOWED_KEYS = ["unit", "count", "owner"] as const;
const CONSUMPTION_ALLOWED_KEYS = ["kind", "maxCount"] as const;
const EXPIRATION_ALLOWED_KEYS = ["conditions"] as const;

const DURATION_TIME_UNITS = ["ACTION", "TURN", "BATTLE", "HIT", "SKILL_USE"] as const;
const DURATION_OWNERS = ["EFFECT_TARGET", "EFFECT_SOURCE", "BATTLE"] as const;
const CONSUMPTION_KINDS = [
  "NEXT_OUTGOING_ATTACK",
  "NEXT_INCOMING_ATTACK",
  "INCOMING_HIT",
  "OUTGOING_HIT",
  "STATUS_BLOCKED",
  "LETHAL_DAMAGE",
] as const;

export interface DurationTimeLimit {
  readonly unit: DurationTimeUnit;
  readonly count: number;
  readonly owner?: DurationOwner;
}

export interface DurationConsumption {
  readonly kind: ConsumptionKind;
  readonly maxCount: number;
}

export interface DurationExpiration {
  readonly conditions: readonly ConditionDefinition[];
}

export interface DurationDefinition {
  readonly timeLimit?: DurationTimeLimit;
  readonly consumption?: DurationConsumption;
  readonly expiration?: DurationExpiration;
  readonly dispellable: boolean;
  readonly linkedEffectGroupId: string | null;
}

export interface DurationTimeLimitInput {
  readonly unit: string;
  readonly count: number;
  readonly owner?: string;
}

export interface DurationConsumptionInput {
  readonly kind: string;
  readonly maxCount: number;
}

export interface DurationExpirationInput {
  readonly conditions: readonly ConditionDefinitionInput[];
}

export interface DurationDefinitionInput {
  readonly timeLimit?: DurationTimeLimitInput;
  readonly consumption?: DurationConsumptionInput;
  readonly expiration?: DurationExpirationInput;
  readonly dispellable?: boolean;
  readonly linkedEffectGroupId?: string | null;
}

function createTimeLimit(input: DurationTimeLimitInput, path: string): DurationTimeLimit {
  assertKnownKeys(input, TIME_LIMIT_ALLOWED_KEYS, path);
  assertEnumValue(input.unit, DURATION_TIME_UNITS, `${path}.unit`);
  assertInteger(input.count, `${path}.count`, { min: 1 });
  if (input.owner === undefined) {
    return { unit: input.unit, count: input.count };
  }
  assertEnumValue(input.owner, DURATION_OWNERS, `${path}.owner`);
  return { unit: input.unit, count: input.count, owner: input.owner };
}

function createConsumption(input: DurationConsumptionInput, path: string): DurationConsumption {
  assertKnownKeys(input, CONSUMPTION_ALLOWED_KEYS, path);
  assertEnumValue(input.kind, CONSUMPTION_KINDS, `${path}.kind`);
  assertInteger(input.maxCount, `${path}.maxCount`, { min: 1 });
  return { kind: input.kind, maxCount: input.maxCount };
}

/**
 * `LETHAL_DAMAGE` consumption and `maxCount` are exercised explicitly by
 * `APPLY_DEATH_SURVIVAL` (issue #6 test list). `exclusiveActivationGroupId`
 * is a `SkillDefinition.traits` field, validated in skill-definition.ts.
 */
export function createDurationDefinition(
  input: DurationDefinitionInput,
  path: string,
  scope: TargetBindingScope | undefined,
): DurationDefinition {
  assertKnownKeys(input, DURATION_ALLOWED_KEYS, path);

  let dispellable = true;
  if (input.dispellable !== undefined) {
    assertBoolean(input.dispellable, `${path}.dispellable`);
    dispellable = input.dispellable;
  }

  let linkedEffectGroupId: string | null = null;
  if (input.linkedEffectGroupId !== undefined && input.linkedEffectGroupId !== null) {
    if (typeof input.linkedEffectGroupId !== "string") {
      throw new DomainValidationError(
        `${path}.linkedEffectGroupId`,
        `must be a string or null, got ${typeof input.linkedEffectGroupId}`,
      );
    }
    linkedEffectGroupId = input.linkedEffectGroupId;
  }

  const result: {
    timeLimit?: DurationTimeLimit;
    consumption?: DurationConsumption;
    expiration?: DurationExpiration;
    dispellable: boolean;
    linkedEffectGroupId: string | null;
  } = { dispellable, linkedEffectGroupId };

  if (input.timeLimit !== undefined) {
    result.timeLimit = createTimeLimit(input.timeLimit, `${path}.timeLimit`);
  }
  if (input.consumption !== undefined) {
    result.consumption = createConsumption(input.consumption, `${path}.consumption`);
  }
  if (input.expiration !== undefined) {
    assertKnownKeys(input.expiration, EXPIRATION_ALLOWED_KEYS, `${path}.expiration`);
    assertArray(input.expiration.conditions, `${path}.expiration.conditions`);
    result.expiration = {
      conditions: input.expiration.conditions.map((c, i) =>
        createConditionDefinition(c, `${path}.expiration.conditions[${i}]`, scope),
      ),
    };
  }
  return result;
}
