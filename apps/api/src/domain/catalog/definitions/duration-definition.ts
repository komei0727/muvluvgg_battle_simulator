import type { DurationOwner, DurationTimeUnit, ConsumptionKind } from "./catalog-enums.js";
import {
  createConditionDefinition,
  type ConditionDefinition,
  type ConditionDefinitionInput,
} from "./condition-definition.js";
import {
  createRuntimeCounterUpdateDefinition,
  type RuntimeCounterUpdateDefinition,
  type RuntimeCounterUpdateDefinitionInput,
} from "./runtime-counter-update-definition.js";
import type { RuntimeCounterId } from "./catalog-ids.js";
import type { TargetBindingScope } from "./references.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertArray,
  assertBoolean,
  assertEnumValue,
  assertInteger,
  assertKnownKeys,
} from "../../shared/validate.js";

const DURATION_ALLOWED_KEYS = [
  "timeLimit",
  "consumption",
  "expiration",
  "dispellable",
  "linkedEffectGroupId",
  "linkedEffectGroupRole",
  "counterUpdates",
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
const LINKED_EFFECT_GROUP_ROLES = ["PARENT", "CHILD"] as const;

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

/**
 * R-EFF-09: 同じ`linkedEffectGroupId`を持つ`AppliedEffect`間のカスケード方向を
 * 明示する。`PARENT`が失効すると理由を問わず同グループ全体へカスケードする
 * （R-EFF-09「グループの親効果が失効・解除された場合、同じグループの子効果と
 * Markerも同時に失効させる」）が、`CHILD`が単独で失効してもカスケードしない
 * （R-EFF-09「子効果だけが消費条件で失効した場合、親効果は維持する」）。
 * どちらのメンバーも`linkedEffectGroupRole`を持たない（レガシー）グループでは
 * 従来どおり対称にカスケードする — グループ内のどのメンバーが失効理由を持つかを
 * `expireEffects`の呼び出し側の`ExpirationSeedReason`から推測しない。
 */
export type LinkedEffectGroupRole = (typeof LINKED_EFFECT_GROUP_ROLES)[number];

export interface DurationDefinition {
  readonly timeLimit?: DurationTimeLimit;
  readonly consumption?: DurationConsumption;
  readonly expiration?: DurationExpiration;
  readonly dispellable: boolean;
  readonly linkedEffectGroupId: string | null;
  readonly linkedEffectGroupRole?: LinkedEffectGroupRole;
  /**
   * `05_ドメインモデル.md`「RuntimeCounter」`AppliedEffect`スコープ（EFF-005、
   * Issue #162）。この効果インスタンス自身が所有するRuntimeCounterの更新契機を
   * 宣言する。`scope`は常に`APPLIED_EFFECT`（他スコープはこの位置では意味を
   * 持たないため拒否する）。`expiration.conditions`の`RUNTIME_COUNTER`参照は、
   * 同じ`DurationDefinition`の`counterUpdates`に宣言された counter だけを
   * 参照できる（`skill-definition.ts`の同名規則と同じ「参照は宣言必須」方針）。
   */
  readonly counterUpdates?: readonly RuntimeCounterUpdateDefinition[];
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
  readonly linkedEffectGroupRole?: string;
  readonly counterUpdates?: readonly RuntimeCounterUpdateDefinitionInput[];
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
 * `RUNTIME_COUNTER` Conditionが参照するcounterは、`R-EFF-11`の所有範囲規則により
 * 同じ`DurationDefinition`が宣言する`counterUpdates`に存在するものだけを許可する
 * （`skill-definition.ts`の`assertRuntimeCounterReferencesAreDeclared`と同じ方針、
 * EFF-005/Issue #162）。AND/OR/NOTを再帰的に辿る。
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

function assertRuntimeCounterReferencesAreDeclared(
  expiration: DurationExpiration | undefined,
  counterUpdates: readonly RuntimeCounterUpdateDefinition[],
  path: string,
): void {
  if (expiration === undefined) {
    return;
  }
  const declared = new Set(counterUpdates.map((update) => update.counter));
  const referenced = new Set<RuntimeCounterId>();
  expiration.conditions.forEach((condition) =>
    collectReferencedRuntimeCounterIds(condition, referenced),
  );
  for (const counter of referenced) {
    if (!declared.has(counter)) {
      throw new DomainValidationError(
        `${path}.counterUpdates`,
        `RUNTIME_COUNTER references undeclared counter "${counter}" (must appear in counterUpdates)`,
      );
    }
  }
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

  if (input.counterUpdates !== undefined) {
    assertArray(input.counterUpdates, `${path}.counterUpdates`);
  }
  const counterUpdates = (input.counterUpdates ?? []).map((c, i) => {
    const update = createRuntimeCounterUpdateDefinition(c, `${path}.counterUpdates[${i}]`);
    if (update.scope !== "APPLIED_EFFECT") {
      throw new DomainValidationError(
        `${path}.counterUpdates[${i}].scope`,
        `must be "APPLIED_EFFECT" when declared on a DurationDefinition, got "${update.scope}"`,
      );
    }
    return update;
  });

  const result: {
    timeLimit?: DurationTimeLimit;
    consumption?: DurationConsumption;
    expiration?: DurationExpiration;
    dispellable: boolean;
    linkedEffectGroupId: string | null;
    linkedEffectGroupRole?: LinkedEffectGroupRole;
    counterUpdates?: readonly RuntimeCounterUpdateDefinition[];
  } = { dispellable, linkedEffectGroupId };
  if (counterUpdates.length > 0) {
    result.counterUpdates = counterUpdates;
  }

  if (input.linkedEffectGroupRole !== undefined) {
    if (linkedEffectGroupId === null) {
      throw new DomainValidationError(
        `${path}.linkedEffectGroupRole`,
        "requires linkedEffectGroupId to be set",
      );
    }
    assertEnumValue(
      input.linkedEffectGroupRole,
      LINKED_EFFECT_GROUP_ROLES,
      `${path}.linkedEffectGroupRole`,
    );
    result.linkedEffectGroupRole = input.linkedEffectGroupRole;
  }

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
  assertRuntimeCounterReferencesAreDeclared(result.expiration, counterUpdates, path);
  return result;
}
