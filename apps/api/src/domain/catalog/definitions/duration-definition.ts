import type {
  ConsumptionKind,
  DamageType,
  DurationOwner,
  DurationTimeUnit,
} from "./catalog-enums.js";
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
  "linkedEffectGroupScope",
  "counterUpdates",
  "reapply",
  "removeOnSourceDefeated",
] as const;
const TIME_LIMIT_ALLOWED_KEYS = [
  "unit",
  "count",
  "owner",
  "countGrantTurn",
  "countGrantAction",
  "countGrantSkillUse",
] as const;

/**
 * 付与した期間そのものの終了も1回と数えるフラグと、そのフラグが意味を持つ単位。
 * 減算の契機はそれぞれの単位の終了時だけなので、他の単位へ宣言しても評価する経路が無い。
 */
const GRANT_SCOPE_FLAG_UNITS = {
  countGrantTurn: "TURN",
  countGrantAction: "ACTION",
  countGrantSkillUse: "SKILL_USE",
} as const;
type GrantScopeFlag = keyof typeof GRANT_SCOPE_FLAG_UNITS;
const CONSUMPTION_ALLOWED_KEYS = ["kind", "maxCount", "damageType", "scope"] as const;
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
const ATTACK_CONSUMPTION_KINDS: readonly ConsumptionKind[] = [
  "NEXT_OUTGOING_ATTACK",
  "NEXT_INCOMING_ATTACK",
];
const CONSUMPTION_DAMAGE_TYPES = ["PHYSICAL", "EN"] as const;
const CONSUMPTION_SCOPES = ["ATTACK", "ACTION"] as const;

export interface DurationTimeLimit {
  readonly unit: DurationTimeUnit;
  readonly count: number;
  readonly owner?: DurationOwner;
  /**
   * R-EFF-06 #2の例外。`true`なら付与されたターンの終了時にも減算する。
   * ターン開始時に付与して「そのターンの間」だけ効かせる効果（`count: 1`で
   * 付与ターンの終了時に失効）を表す。`unit: TURN`でしか意味を持たない。
   */
  readonly countGrantTurn?: true;
  /**
   * R-EFF-04 #2の例外。`true`なら付与された行動の完了時にも、ownerを問わず減算する。
   * 敵の攻撃行動を契機に付与し、その行動の終了で消える保護を表す。行動の外（戦闘開始時・
   * ターン開始時・ターン終了時）で付与した場合は、その解決フェーズの終了で減らす。
   * `count: 1`とだけ組み合わせられる。
   */
  readonly countGrantAction?: true;
  /**
   * `true`なら付与したスキル使用（AS/EX/PS）の終了時、完了イベントの発行前に、
   * ownerを問わず減算する。「このスキル中のみ」の補正（`count: 1`）を表し、
   * 完了イベントを契機にする後続のPSや次の行動へ持ち越さない。
   */
  readonly countGrantSkillUse?: true;
}

/**
 * R-EFF-07: `NEXT_*_ATTACK`の1回分を数える範囲。`ATTACK`（省略時）は1 DAMAGE EffectAction
 * （全対象・全ヒット）、`ACTION`はその攻撃を含む行動全体。行動内の別スキルの攻撃
 * （PSの隣接攻撃と元のAS、敵1行動の複数DAMAGE）までまとめて覆う効果だけが宣言する。
 */
export type ConsumptionScope = (typeof CONSUMPTION_SCOPES)[number];

export interface DurationConsumption {
  readonly kind: ConsumptionKind;
  readonly maxCount: number;
  /**
   * R-EFF-07: 指定したダメージタイプの攻撃だけが消費する（他タイプの攻撃では残る）。
   * 省略時はタイプを問わない。効果自体の対象タイプ（`APPLY_DAMAGE_MOD.damageType`）とは
   * 独立に宣言する — 物理軽減をEN攻撃でも回数消費させるスキルがあるため。
   */
  readonly damageType?: DamageType;
  readonly scope?: ConsumptionScope;
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

/**
 * R-EFF-09: 連動グループのカスケード範囲。`BATTLE`（省略時）は同じ`linkedEffectGroupId`の
 * メンバー全体（保持ユニットを問わない）、`HOLDER`は同じ保持ユニットのメンバーだけで
 * 連動する。敵ごとに失効時期が違う付与（例: 対象の1行動で消える刻痕）を連動させると、
 * `BATTLE`ではある対象の親の失効が他の対象の子まで解除してしまう。
 * `SKILL_USE`は同じ保持ユニットかつ同じスキル使用（`SkillUseId`）で付与されたメンバー
 * だけで連動する。同じスキルを繰り返し使って重複付与したセット（例: シールドと、
 * シールドと同時に消えるバフ）を、セットごとに独立して連動させるためのもの。
 */
export const LINKED_EFFECT_GROUP_SCOPES = ["BATTLE", "HOLDER", "SKILL_USE"] as const;
export type LinkedEffectGroupScope = (typeof LINKED_EFFECT_GROUP_SCOPES)[number];

export interface DurationDefinition {
  readonly timeLimit?: DurationTimeLimit;
  readonly consumption?: DurationConsumption;
  readonly expiration?: DurationExpiration;
  readonly dispellable: boolean;
  readonly linkedEffectGroupId: string | null;
  readonly linkedEffectGroupRole?: LinkedEffectGroupRole;
  /** 省略時は`BATTLE`（従来どおり保持ユニットを問わず連動する）。 */
  readonly linkedEffectGroupScope?: LinkedEffectGroupScope;
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
  /**
   * R-EFF-10（`MARKER_REMOVAL_ON_SOURCE_DEATH`、M7-020、Issue #279）: 付与者
   * （`MarkerState.sourceUnitId`／`AppliedEffect.sourceUnitId`）が戦闘不能になった
   * 時点でこの効果を解除する。`SKL_AOI_ELEGANT_AS1`（百花繚乱）のraw原文
   * 「「高揚」は付与者が倒れると同時に解除される」を表す。
   *
   * `expiration.conditions`（R-EFF-08）ではなく専用フィールドにしたのは、Marker
   * 側のexpiration機構自体が未実装（`catalog-integrity.ts`の
   * `UNSUPPORTED_MARKER_DURATION`）であり、Condition表現を導入すると同機構ごと
   * 実装する必要があるため。当初`APPLY_MARKER`専用だったが、`APPLY_SHIELD`
   * （`MARKER_REMOVAL_ON_SOURCE_DEATH`と同じ形の解除経路を`expireEffects`
   * 経由で持つ、Issue #660）へも拡張した。それ以外の`DurationDefinition`へ
   * 宣言しても評価する経路が無いため、`catalog-integrity.ts`が
   * `UNSUPPORTED_SOURCE_DEFEATED_REMOVAL`としてCatalogロード時点で拒否する。
   */
  readonly removeOnSourceDefeated?: boolean;
}

export interface DurationTimeLimitInput {
  readonly unit: string;
  readonly count: number;
  readonly owner?: string;
  readonly countGrantTurn?: boolean;
  readonly countGrantAction?: boolean;
  readonly countGrantSkillUse?: boolean;
}

export interface DurationConsumptionInput {
  readonly kind: string;
  readonly maxCount: number;
  readonly damageType?: string;
  readonly scope?: string;
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
  readonly linkedEffectGroupScope?: string;
  readonly counterUpdates?: readonly RuntimeCounterUpdateDefinitionInput[];
  readonly reapply?: DurationReapplyInput;
  readonly removeOnSourceDefeated?: boolean;
}

function createTimeLimit(input: DurationTimeLimitInput, path: string): DurationTimeLimit {
  assertKnownKeys(input, TIME_LIMIT_ALLOWED_KEYS, path);
  assertEnumValue(input.unit, DURATION_TIME_UNITS, `${path}.unit`);
  assertInteger(input.count, `${path}.count`, { min: 1 });
  const grantScopeFlags = createGrantScopeFlags(input, path);
  if (input.owner === undefined) {
    return { unit: input.unit, count: input.count, ...grantScopeFlags };
  }
  assertEnumValue(input.owner, DURATION_OWNERS, `${path}.owner`);
  return { unit: input.unit, count: input.count, owner: input.owner, ...grantScopeFlags };
}

/**
 * `false`は省略と同じ意味になり宣言の揺れを生むだけなので、`true`だけを受理する。
 */
function createGrantScopeFlags(
  input: DurationTimeLimitInput,
  path: string,
): { readonly [Flag in GrantScopeFlag]?: true } {
  const flags: { [Flag in GrantScopeFlag]?: true } = {};
  for (const flag of Object.keys(GRANT_SCOPE_FLAG_UNITS) as GrantScopeFlag[]) {
    const value = input[flag];
    if (value === undefined) {
      continue;
    }
    if (value !== true) {
      throw new DomainValidationError(`${path}.${flag}`, "must be true when present");
    }
    if (input.unit !== GRANT_SCOPE_FLAG_UNITS[flag]) {
      throw new DomainValidationError(
        `${path}.${flag}`,
        `requires unit ${GRANT_SCOPE_FLAG_UNITS[flag]}`,
      );
    }
    // 行動の外で付与した場合は付与した解決フェーズの終了で減らすが、フェーズは効果へ
    // 記録しないため、2回目以降の減算契機を区別できない。1回で終わる効果に限る。
    if (flag === "countGrantAction" && input.count !== 1) {
      throw new DomainValidationError(`${path}.${flag}`, "requires count 1");
    }
    flags[flag] = true;
  }
  return flags;
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
  const result: { -readonly [K in keyof DurationConsumption]: DurationConsumption[K] } = {
    kind: input.kind,
    maxCount: input.maxCount,
  };
  // 攻撃のダメージタイプと攻撃・行動の範囲は、攻撃単位で消費するkindにしか存在しない。
  if (
    (input.damageType !== undefined || input.scope !== undefined) &&
    !ATTACK_CONSUMPTION_KINDS.includes(input.kind)
  ) {
    throw new DomainValidationError(
      path,
      "damageType and scope are only supported with kind NEXT_OUTGOING_ATTACK or NEXT_INCOMING_ATTACK",
    );
  }
  if (input.damageType !== undefined) {
    assertEnumValue(input.damageType, CONSUMPTION_DAMAGE_TYPES, `${path}.damageType`);
    result.damageType = input.damageType;
  }
  if (input.scope !== undefined) {
    assertEnumValue(input.scope, CONSUMPTION_SCOPES, `${path}.scope`);
    // 行動の途中で残数が0になっても失効は行動の完了まで遅れるため、2回目以降を
    // 同じ行動の後続攻撃と区別できない。1回で消える効果だけを許可する。
    if (input.scope === "ACTION" && input.maxCount !== 1) {
      throw new DomainValidationError(`${path}.scope`, "ACTION requires maxCount 1");
    }
    result.scope = input.scope;
  }
  return result;
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
    linkedEffectGroupScope?: LinkedEffectGroupScope;
    counterUpdates?: readonly RuntimeCounterUpdateDefinition[];
    reapply?: DurationReapply;
    removeOnSourceDefeated?: boolean;
  } = { dispellable, linkedEffectGroupId };
  if (counterUpdates.length > 0) {
    result.counterUpdates = counterUpdates;
  }

  if (input.removeOnSourceDefeated !== undefined) {
    assertBoolean(input.removeOnSourceDefeated, `${path}.removeOnSourceDefeated`);
    result.removeOnSourceDefeated = input.removeOnSourceDefeated;
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

  if (input.linkedEffectGroupScope !== undefined) {
    if (linkedEffectGroupId === null) {
      throw new DomainValidationError(
        `${path}.linkedEffectGroupScope`,
        "requires linkedEffectGroupId to be set",
      );
    }
    assertEnumValue(
      input.linkedEffectGroupScope,
      LINKED_EFFECT_GROUP_SCOPES,
      `${path}.linkedEffectGroupScope`,
    );
    result.linkedEffectGroupScope = input.linkedEffectGroupScope;
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
