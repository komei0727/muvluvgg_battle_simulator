import type { EventCategory } from "./catalog-enums.js";
import {
  createConditionDefinition,
  type ConditionDefinition,
  type ConditionDefinitionInput,
} from "./condition-definition.js";
import { DomainValidationError } from "../shared/errors.js";
import { assertEnumValue, assertKnownKeys } from "../shared/validate.js";

const EVENT_CATEGORIES = ["FACT", "TIMING"] as const;
const TRIGGER_ALLOWED_KEYS = [
  "eventType",
  "category",
  "sourceSelector",
  "targetSelector",
  "condition",
] as const;

/**
 * Attested across `08_ドメインイベント.md`/`14_Catalog定義スキーマ.md` examples
 * (自身=SELF, 味方=ALLY, 敵=ENEMY, ANY, EFFECT_OWNER). `eventType` itself is
 * left as an open string: `14_Catalog定義スキーマ.md`'s eventType table only
 * lists v2 additions "in addition to v1's events", so the full closed set
 * lives outside this document and validating it is a Catalog integrity
 * concern (issue #7), not this Mapper's.
 */
const EVENT_SELECTORS = ["SELF", "ALLY", "ENEMY", "ANY", "EFFECT_OWNER"] as const;

export interface TriggerDefinition {
  readonly eventType: string;
  readonly category: EventCategory;
  readonly sourceSelector: (typeof EVENT_SELECTORS)[number];
  readonly targetSelector: (typeof EVENT_SELECTORS)[number];
  readonly condition: ConditionDefinition;
}

export interface TriggerDefinitionInput {
  readonly eventType: string;
  readonly category: string;
  readonly sourceSelector: string;
  readonly targetSelector: string;
  readonly condition?: ConditionDefinitionInput;
}

export function createTriggerDefinition(
  input: TriggerDefinitionInput,
  path: string,
): TriggerDefinition {
  assertKnownKeys(input, TRIGGER_ALLOWED_KEYS, path);
  if (input.eventType.length === 0) {
    throw new DomainValidationError(`${path}.eventType`, "must not be empty");
  }
  assertEnumValue(input.category, EVENT_CATEGORIES, `${path}.category`);
  assertEnumValue(input.sourceSelector, EVENT_SELECTORS, `${path}.sourceSelector`);
  assertEnumValue(input.targetSelector, EVENT_SELECTORS, `${path}.targetSelector`);

  return {
    eventType: input.eventType,
    category: input.category,
    sourceSelector: input.sourceSelector,
    targetSelector: input.targetSelector,
    condition:
      input.condition === undefined
        ? { kind: "TRUE" }
        : createConditionDefinition(input.condition, `${path}.condition`, undefined),
  };
}
