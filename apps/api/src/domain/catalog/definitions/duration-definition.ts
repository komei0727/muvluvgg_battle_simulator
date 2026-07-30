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
  "reapply",
] as const;
const TIME_LIMIT_ALLOWED_KEYS = ["unit", "count", "owner"] as const;
const CONSUMPTION_ALLOWED_KEYS = ["kind", "maxCount"] as const;
const EXPIRATION_ALLOWED_KEYS = ["conditions"] as const;
const REAPPLY_ALLOWED_KEYS = ["existingRemaining", "count"] as const;
const REAPPLY_REMAINING_ALLOWED_KEYS = ["op", "value"] as const;

/**
 * `HAS_MARKER.countCondition`（`target-selector-definition.ts`）と同じ理由で
 * 数値比較だけを許可する。`existingRemaining`は常に既存インスタンスの残り回数
 * （整数）との比較であり、`IN`/`CONTAINS`は評価側に対応する意味を持たない。
 */
const REAPPLY_COMPARISON_OPERATORS = ["GT", "GTE", "LT", "LTE", "EQ", "NEQ"] as const;

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

/** `DurationReapply.existingRemaining`が使う数値比較演算子（`IN`/`CONTAINS`は含まない）。 */
export type ReapplyComparisonOperator = (typeof REAPPLY_COMPARISON_OPERATORS)[number];

/**
 * R-EFF-12（`DYNAMIC_DURATION_ON_REAPPLY`、M7-014、Issue #268）: 同じ効果が
 * 既に対象へ残っている場合だけ、`timeLimit.count`の代わりに`count`を初期残り
 * 回数として付与する。`unit`・`owner`は`timeLimit`のものを引き継ぐため、
 * `existingRemaining`の比較は常に同じ期間単位どうしの比較になる（別単位を
 * 宣言できてしまう余地を型で消す）。
 *
 * raw原文の例（`SKL_SIENA_DIVA_PS1`「コン・フオーコ」）:
 * 「1行動の気絶を付与する。対象に1行動の気絶が付与されていた場合は、2行動の
 * 気絶に上書きする」＝ `timeLimit: {ACTION, 1}` ＋
 * `reapply: {existingRemaining: {op: EQ, value: 1}, count: 2}`。
 */
export interface DurationReapply {
  readonly existingRemaining: {
    readonly op: ReapplyComparisonOperator;
    readonly value: number;
  };
  readonly count: number;
}

/**
 * R-EFF-09: 同じ`linkedEffectGroupId`を持つメンバー間のカスケード方向を
 * 明示する。`PARENT`が失効すると理由を問わず同グループ全体へカスケードする
 * （R-EFF-09「グループの親効果が失効・解除された場合、同じグループの子効果と
 * Markerも同時に失効させる」）が、`CHILD`が単独で失効してもカスケードしない
 * （R-EFF-09「子効果だけが消費条件で失効した場合、親効果は維持する」）。
 * どちらのメンバーも`linkedEffectGroupRole`を持たない（レガシー）グループでは
 * 従来どおり対称にカスケードする — グループ内のどのメンバーが失効理由を持つかを
 * `expireEffects`の呼び出し側の`ExpirationSeedReason`から推測しない。
 *
 * M7-013（Issue #267）: ロールは`AppliedEffect`同士のグループだけでなく、
 * `AppliedEffect`と`MarkerState`が混在するグループ（R-EFF-09第1項）でも同じ
 * 意味で使う — production Catalogの`TARISA_TROUBLEMAKER_PS1_LINK`／
 * `AOI_ELEGANT_AS1_KOUYOU_LINK`はMarkerを`PARENT`、`AppliedEffect`を`CHILD`と
 * 宣言し、「Markerの解除が効果へ連動し、効果単独の失効はMarkerへ連動しない」を
 * 表す。
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
  /**
   * R-EFF-12（M7-014、Issue #268）: 再付与時に既存インスタンスの残り回数を見て
   * 初期残り回数を差し替える。`timeLimit`が無い（即時効果）durationには宣言
   * できない。
   */
  readonly reapply?: DurationReapply;
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

export interface DurationReapplyInput {
  readonly existingRemaining: { readonly op: string; readonly value: number };
  readonly count: number;
}

export interface DurationDefinitionInput {
  readonly timeLimit?: DurationTimeLimitInput;
  readonly consumption?: DurationConsumptionInput;
  readonly expiration?: DurationExpirationInput;
  readonly dispellable?: boolean;
  readonly linkedEffectGroupId?: string | null;
  readonly linkedEffectGroupRole?: string;
  readonly counterUpdates?: readonly RuntimeCounterUpdateDefinitionInput[];
  readonly reapply?: DurationReapplyInput;
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

function createReapply(
  input: DurationReapplyInput,
  timeLimit: DurationTimeLimit | undefined,
  path: string,
): DurationReapply {
  assertKnownKeys(input, REAPPLY_ALLOWED_KEYS, path);
  // 即時効果（`timeLimit`無し）に再付与時の残り回数を宣言しても、比較対象も
  // 差し替え先も存在しない。`unit`/`owner`を`timeLimit`から引き継ぐという
  // 設計自体が成立しないため、Catalogロード時点で拒否する。
  if (timeLimit === undefined) {
    throw new DomainValidationError(path, "requires timeLimit to be set");
  }
  const remaining = input.existingRemaining;
  assertKnownKeys(remaining, REAPPLY_REMAINING_ALLOWED_KEYS, `${path}.existingRemaining`);
  assertEnumValue(remaining.op, REAPPLY_COMPARISON_OPERATORS, `${path}.existingRemaining.op`);
  assertInteger(remaining.value, `${path}.existingRemaining.value`, { min: 0 });
  assertInteger(input.count, `${path}.count`, { min: 1 });
  return { existingRemaining: { op: remaining.op, value: remaining.value }, count: input.count };
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
    reapply?: DurationReapply;
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
  if (input.reapply !== undefined) {
    result.reapply = createReapply(input.reapply, result.timeLimit, `${path}.reapply`);
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
