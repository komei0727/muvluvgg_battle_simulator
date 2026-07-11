import type { DurationOwner, DurationTimeUnit, ConsumptionKind } from "./catalog-enums.js";
import {
  createConditionDefinition,
  type ConditionDefinition,
  type ConditionDefinitionInput,
} from "./condition-definition.js";
import type { TargetBindingScope } from "./references.js";
import { assertEnumValue, assertInteger } from "../shared/validate.js";

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
  assertEnumValue(input.unit, DURATION_TIME_UNITS, `${path}.unit`);
  assertInteger(input.count, `${path}.count`, { min: 1 });
  if (input.owner === undefined) {
    return { unit: input.unit, count: input.count };
  }
  assertEnumValue(input.owner, DURATION_OWNERS, `${path}.owner`);
  return { unit: input.unit, count: input.count, owner: input.owner };
}

function createConsumption(input: DurationConsumptionInput, path: string): DurationConsumption {
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
  const dispellable = input.dispellable ?? true;
  const linkedEffectGroupId = input.linkedEffectGroupId ?? null;

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
    result.expiration = {
      conditions: input.expiration.conditions.map((c, i) =>
        createConditionDefinition(c, `${path}.expiration.conditions[${i}]`, scope),
      ),
    };
  }
  return result;
}
