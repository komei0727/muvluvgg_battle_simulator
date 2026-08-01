import {
  CONTINUOUS_DAMAGE_KINDS,
  STAT_KINDS,
  STATUS_AILMENT_CONTINUOUS_DAMAGE_KINDS,
} from "./catalog-enums.js";
import type {
  ComparisonOperator,
  ContinuousDamageKind,
  EffectImmunityCategory,
  Side,
  StatKind,
} from "./catalog-enums.js";
import {
  createMarkerId,
  createRuntimeCounterId,
  type MarkerId,
  type RuntimeCounterId,
} from "./catalog-ids.js";
import {
  createTargetReference,
  targetReferenceEquals,
  type TargetBindingScope,
  type TargetReference,
  type TargetReferenceInput,
} from "./references.js";
import { DomainValidationError } from "../../shared/errors.js";
import {
  assertBoolean,
  assertEnumValue,
  assertFinite,
  assertInteger,
  assertKnownKeys,
  assertNonEmptyArray,
} from "../../shared/validate.js";

export type JsonPrimitive = string | number | boolean;

export const COMPARISON_OPERATORS = [
  "GT",
  "GTE",
  "LT",
  "LTE",
  "EQ",
  "NEQ",
  "IN",
  "CONTAINS",
] as const;

const TARGET_STATE_FIELDS = [
  "IS_ALIVE",
  "HP_RATIO",
  "ATTRIBUTE",
  "UNIT_TYPE",
  "ROLE",
  "POSITION_ROW",
  "POSITION_COLUMN",
  "HAS_STATUS",
  "RESOURCE_AP",
  "RESOURCE_PP",
  "RESOURCE_EX_GAUGE",
] as const;
export type TargetStateField = (typeof TARGET_STATE_FIELDS)[number];

/**
 * `TARGET_STATE.field`ごとの`value`の型。`APPLY_DAMAGE_MOD.condition`の
 * `UNIT_STATE`（DMG-002、Issue #192）も同じ語彙・同じ型検査を使うため公開する。
 */
export const TARGET_STATE_FIELD_TYPES: Record<TargetStateField, "boolean" | "number" | "string"> = {
  IS_ALIVE: "boolean",
  HP_RATIO: "number",
  ATTRIBUTE: "string",
  UNIT_TYPE: "string",
  ROLE: "string",
  POSITION_ROW: "string",
  POSITION_COLUMN: "string",
  HAS_STATUS: "string",
  RESOURCE_AP: "number",
  RESOURCE_PP: "number",
  RESOURCE_EX_GAUGE: "number",
};

const CONDITION_KINDS = [
  "TRUE",
  "AND",
  "OR",
  "NOT",
  "TARGET_STATE",
  "TARGET_HAS_MARKER",
  "EVENT_PAYLOAD",
  "LAST_RESULT",
  "RUNTIME_COUNTER",
  "TURN_NUMBER",
  "ALIVE_UNIT_COUNT",
  "POSITION_RELATION",
  "RESOLUTION_PHASE",
  "TARGET_SET_COUNT",
  "TARGET_HAS_EFFECT",
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

/**
 * M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`）: `TARGET_HAS_EFFECT.categories`
 * に指定できる分類軸。`EffectImmunityCategory`（`REMOVE_EFFECTS`/`EFFECT_IMMUNITY`と
 * 共有する軸、R-EFF-02/03）のうち`MARKER`と`SPECIFIC_EFFECT`を除く。
 *
 * - `MARKER`: `MarkerState`は`AppliedEffect`ではなく、照会は`TARGET_HAS_MARKER`が担う
 * - `SPECIFIC_EFFECT`: 分類軸ではなく`effectActionDefinitionId`の直接一致であり、
 *   「対象が特定の効果を持つか」を表す条件は現行productionに存在しない
 *
 * どちらも受理すると「schemaは通るが実行時に一切一致しない」定義を作れてしまうため、
 * Catalogロード時点で拒否する。
 */
export const TARGET_HAS_EFFECT_CATEGORIES = [
  "BUFF",
  "DEBUFF",
  "STATUS",
  "DAMAGE_MOD",
  "SHIELD",
  "SUBUNIT",
] as const satisfies readonly EffectImmunityCategory[];
export type TargetHasEffectCategory = (typeof TARGET_HAS_EFFECT_CATEGORIES)[number];

/**
 * `continuousDamageKinds`（`APPLY_CONTINUOUS_DAMAGE`は`DEBUFF`、うち炎上・毒は
 * `STATUS`も持つ）／`statKinds`（`APPLY_STAT_MOD`は符号で`BUFF`/`DEBUFF`）は、
 * `categories`がその分類を含んでいなければ実行時に一切一致しない。
 * `EFFECT_IMMUNITY.statusKinds`（M7-001B、Issue #243）と同じ理由で、そうした
 * 「黙って効かない定義」をロード時に拒否する。
 *
 * RES-004-STATUS-CONDITION（Issue #224）: 炎上・毒が`STATUS`にも分類されるように
 * なった（`effect-category-classifier.ts`）ため、「状態異常のうち毒だけ」という
 * 照会は到達可能になった。
 *
 * PR #288レビュー[P2]: ただし判定はフィールド単位ではなく**値ごと**に行う。
 * `APPLY_CONTINUOUS_DAMAGE`が`STATUS`になるのは炎上・毒だけで、`FIXED`（固定継続
 * ダメージ）は名前付きの状態異常ではないため`DEBUFF`にしか分類されない（R-STS-01）。
 * 「`categories`が`STATUS`を含んでいればフィールドごと許可」にすると、実行時に
 * 絶対一致しない`categories: ["STATUS"]` + `continuousDamageKinds: ["FIXED"]`が
 * 通ってしまい、このファイル自身の契約に反する。どの種別が状態異常かは
 * `STATUS_AILMENT_CONTINUOUS_DAMAGE_KINDS`（`catalog-enums.ts`、
 * `effect-category-classifier.ts`と共有する唯一の正本）から導く。
 */
function reachableCategoriesOf(
  field: "continuousDamageKinds" | "statKinds",
  value: string,
): readonly TargetHasEffectCategory[] {
  if (field === "statKinds") {
    // `APPLY_STAT_MOD`は符号で`BUFF`/`DEBUFF`のどちらにもなるため、statごとの差はない。
    return ["BUFF", "DEBUFF"];
  }
  return STATUS_AILMENT_CONTINUOUS_DAMAGE_KINDS.some((ailment) => ailment === value)
    ? ["DEBUFF", "STATUS"]
    : ["DEBUFF"];
}

/**
 * R-SKL-06（CAP_EFFECT_STEP_CONDITION_SCOPE、Issue #230 RES-004-CONDITION-SCOPE）:
 * ACTION stepの`stepCondition`（step全体を一度だけ評価するgate。falseなら
 * `EffectStepSkipped`）に許可するkind。`TARGET_STATE`/`TARGET_HAS_MARKER`は
 * 対象ごとに真偽が変わりうる（`targetCondition`専用のscope）ため、参照先を
 * 問わず常にここから除外する — Issue #227までの「参照先が異なれば
 * stepワイド扱い」という動的な分岐をやめ、フィールドの型自体でscopeを
 * 固定する（DoD「型レベルで両スコープを区別する」）。
 */
export const STEP_CONDITION_KINDS: ReadonlySet<ConditionKind> = new Set(
  CONDITION_KINDS.filter(
    (kind) =>
      kind !== "TARGET_STATE" && kind !== "TARGET_HAS_MARKER" && kind !== "TARGET_HAS_EFFECT",
  ),
);

/**
 * ACTION stepの`targetCondition`（対象ごとに個別評価するfilter。false の
 * 対象だけをこのstepの`actions`適用から除外し、全対象falseなら対象0件の
 * `SKIPPED` LastResultになる、R-SKL-08）に許可するkind。`TARGET_SET_COUNT`
 * （集合全体で1回だけ評価する）や`LAST_RESULT`等のstep全体スコープの
 * kindは、意味的に「対象ごと」に評価できないため`stepCondition`専用とする。
 * `EVENT_PAYLOAD`（CAP_TRIGGER_PAYLOAD_IN_RESOLUTION、Issue #247 M7-001D）は
 * 値自体は対象によらず一定（トリガーイベントのpayload）だが、
 * `TARGET_STATE`/`TARGET_HAS_MARKER`とANDで組み合わせて「対象がXである、
 * かつトリガーイベントのpayloadがYである」という対象ごとのfilterを
 * 表現できるようにするため、ここでも許可する。
 */
export const TARGET_CONDITION_KINDS: ReadonlySet<ConditionKind> = new Set([
  "TRUE",
  "AND",
  "OR",
  "NOT",
  "TARGET_STATE",
  "TARGET_HAS_MARKER",
  "TARGET_HAS_EFFECT",
  "EVENT_PAYLOAD",
]);

/**
 * `condition`ツリー（AND/OR/NOTを再帰的に見る）が`allowedKinds`だけで
 * 構成されているかを検証する。ACTION stepの`stepCondition`/`targetCondition`
 * それぞれのscope制約（Issue #230）に使う。
 */
export function assertConditionKindsWithin(
  condition: ConditionDefinition,
  allowedKinds: ReadonlySet<ConditionKind>,
  path: string,
): void {
  if (!allowedKinds.has(condition.kind)) {
    throw new DomainValidationError(
      path,
      `kind "${condition.kind}" is not allowed in this scope (allowed: ${[...allowedKinds].join(", ")})`,
    );
  }
  switch (condition.kind) {
    case "AND":
    case "OR":
      condition.conditions.forEach((c, i) =>
        assertConditionKindsWithin(c, allowedKinds, `${path}.conditions[${i}]`),
      );
      return;
    case "NOT":
      assertConditionKindsWithin(condition.condition, allowedKinds, `${path}.condition`);
      return;
    default:
      return;
  }
}

/**
 * `targetCondition`内の`TARGET_STATE`/`TARGET_HAS_MARKER`が、すべてこの
 * ACTION step自身の`target`（`expectedTarget`）を参照しているかを検証する
 * （AND/OR/NOTを再帰的に見る）。`targetCondition`は常に「このstepが今まさに
 * 処理している対象」の filterであり、他の`TargetReference`を参照する
 * 意味を持たない（そうしたければ`stepCondition`側で評価する別Capabilityの
 * 対象になる、Issue #230スコープ外）。
 */
export function assertTargetConditionReferencesOwnTarget(
  condition: ConditionDefinition,
  expectedTarget: TargetReference,
  path: string,
): void {
  switch (condition.kind) {
    case "TARGET_STATE":
    case "TARGET_HAS_MARKER":
    case "TARGET_HAS_EFFECT":
      if (!targetReferenceEquals(condition.target, expectedTarget)) {
        throw new DomainValidationError(
          `${path}.target`,
          "must reference this ACTION step's own target (targetCondition only filters the step's own target set; a fixed different TargetReference is out of scope, see stepCondition instead)",
        );
      }
      return;
    case "AND":
    case "OR":
      condition.conditions.forEach((c, i) =>
        assertTargetConditionReferencesOwnTarget(c, expectedTarget, `${path}.conditions[${i}]`),
      );
      return;
    case "NOT":
      assertTargetConditionReferencesOwnTarget(
        condition.condition,
        expectedTarget,
        `${path}.condition`,
      );
      return;
    default:
      return;
  }
}

const CONDITION_ALLOWED_KEYS: Record<ConditionKind, readonly string[]> = {
  TRUE: ["kind"],
  AND: ["kind", "conditions"],
  OR: ["kind", "conditions"],
  NOT: ["kind", "condition"],
  TARGET_STATE: ["kind", "target", "field", "op", "value"],
  TARGET_HAS_MARKER: ["kind", "target", "markerId", "countCondition"],
  EVENT_PAYLOAD: ["kind", "field", "op", "value"],
  LAST_RESULT: ["kind", "field", "op", "value"],
  RUNTIME_COUNTER: ["kind", "counter", "op", "value", "modulo"],
  TURN_NUMBER: ["kind", "op", "value", "modulo"],
  ALIVE_UNIT_COUNT: ["kind", "side", "excludeSelf", "op", "value"],
  POSITION_RELATION: ["kind", "target", "relation"],
  RESOLUTION_PHASE: ["kind", "phase", "negate"],
  TARGET_SET_COUNT: ["kind", "target", "op", "value"],
  TARGET_HAS_EFFECT: ["kind", "target", "categories", "continuousDamageKinds", "statKinds"],
};
const MARKER_COUNT_CONDITION_ALLOWED_KEYS = ["op", "value"] as const;
const SIDES = ["ALLY", "ENEMY", "ALL"] as const;

/** `14_Catalog定義スキーマ.md`「POSITION_RELATION」（M6、Issue #144）。「目の前」を候補とする。 */
export const POSITION_RELATIONS = ["IN_FRONT_OF"] as const;
export type PositionRelation = (typeof POSITION_RELATIONS)[number];

/** `14_Catalog定義スキーマ.md`「RESOLUTION_PHASE」（M6、Issue #144）。 */
export const RESOLUTION_PHASES = ["BATTLE_START", "TURN_START", "TURN_END"] as const;
export type ResolutionPhase = (typeof RESOLUTION_PHASES)[number];

export interface MarkerCountCondition {
  readonly op: ComparisonOperator;
  readonly value: number;
}

export type ConditionDefinition =
  | { readonly kind: "TRUE" }
  | { readonly kind: "AND"; readonly conditions: readonly ConditionDefinition[] }
  | { readonly kind: "OR"; readonly conditions: readonly ConditionDefinition[] }
  | { readonly kind: "NOT"; readonly condition: ConditionDefinition }
  | {
      readonly kind: "TARGET_STATE";
      readonly target: TargetReference;
      readonly field: TargetStateField;
      readonly op: ComparisonOperator;
      readonly value: JsonPrimitive;
    }
  | {
      readonly kind: "TARGET_HAS_MARKER";
      readonly target: TargetReference;
      readonly markerId: MarkerId;
      readonly countCondition?: MarkerCountCondition;
    }
  | {
      readonly kind: "EVENT_PAYLOAD";
      readonly field: string;
      readonly op: ComparisonOperator;
      readonly value: JsonPrimitive;
    }
  | {
      readonly kind: "LAST_RESULT";
      readonly field: string;
      readonly op: ComparisonOperator;
      readonly value: JsonPrimitive;
    }
  | {
      readonly kind: "RUNTIME_COUNTER";
      readonly counter: RuntimeCounterId;
      readonly op: ComparisonOperator;
      readonly value: number;
      readonly modulo?: number;
    }
  | {
      readonly kind: "TURN_NUMBER";
      readonly op: ComparisonOperator;
      readonly value: number;
      readonly modulo?: number;
    }
  | {
      readonly kind: "ALIVE_UNIT_COUNT";
      readonly side: Side;
      readonly excludeSelf: boolean;
      readonly op: ComparisonOperator;
      readonly value: number;
    }
  | {
      readonly kind: "POSITION_RELATION";
      readonly target: TargetReference;
      readonly relation: PositionRelation;
    }
  | {
      readonly kind: "RESOLUTION_PHASE";
      readonly phase: ResolutionPhase;
      readonly negate: boolean;
    }
  | {
      readonly kind: "TARGET_SET_COUNT";
      readonly target: TargetReference;
      readonly op: ComparisonOperator;
      readonly value: number;
    }
  | {
      readonly kind: "TARGET_HAS_EFFECT";
      readonly target: TargetReference;
      /** 少なくとも1つに一致する`AppliedEffect`を対象が保持していれば真。 */
      readonly categories: readonly TargetHasEffectCategory[];
      /** 指定時、一致対象を`APPLY_CONTINUOUS_DAMAGE`のこの種別（毒・炎上）へ絞る。 */
      readonly continuousDamageKinds?: readonly ContinuousDamageKind[];
      /** 指定時、一致対象を`APPLY_STAT_MOD`のこの補正stat（攻撃力など）へ絞る。 */
      readonly statKinds?: readonly StatKind[];
    };

export interface ConditionDefinitionInput {
  readonly kind: string;
  readonly conditions?: readonly ConditionDefinitionInput[];
  readonly condition?: ConditionDefinitionInput;
  readonly target?: TargetReferenceInput;
  readonly field?: string;
  readonly op?: string;
  readonly value?: JsonPrimitive;
  readonly markerId?: string;
  readonly countCondition?: { readonly op: string; readonly value: number };
  readonly counter?: string;
  readonly modulo?: number;
  readonly side?: string;
  readonly excludeSelf?: boolean;
  readonly relation?: string;
  readonly phase?: string;
  readonly negate?: boolean;
  readonly categories?: readonly string[];
  readonly continuousDamageKinds?: readonly string[];
  readonly statKinds?: readonly string[];
}

function requireField<K extends keyof ConditionDefinitionInput>(
  input: ConditionDefinitionInput,
  key: K,
  path: string,
): NonNullable<ConditionDefinitionInput[K]> {
  const value = input[key];
  if (value === undefined) {
    throw new DomainValidationError(`${path}.${key}`, "is required");
  }
  return value;
}

function requireNumberField(input: ConditionDefinitionInput, path: string): number {
  const value = requireField(input, "value", path);
  if (typeof value !== "number") {
    throw new DomainValidationError(`${path}.value`, `must be a number, got ${typeof value}`);
  }
  assertFinite(value, `${path}.value`);
  return value;
}

function createOperator(input: ConditionDefinitionInput, path: string): ComparisonOperator {
  const op = requireField(input, "op", path);
  assertEnumValue(op, COMPARISON_OPERATORS, `${path}.op`);
  return op;
}

/**
 * `TARGET_HAS_EFFECT`の絞り込みfield（`continuousDamageKinds`/`statKinds`）を
 * 検証して、指定がある場合だけ持つ部分オブジェクトを返す。空配列と未知値のほか、
 * `categories`から到達できない値（`reachableCategoriesOf`）も拒否する。
 */
function createNarrowing<Field extends "continuousDamageKinds" | "statKinds", Value extends string>(
  input: ConditionDefinitionInput,
  field: Field,
  allowedValues: readonly Value[],
  categories: readonly TargetHasEffectCategory[],
  path: string,
): { readonly [K in Field]?: readonly Value[] } {
  const values = input[field];
  if (values === undefined) {
    return {};
  }
  assertNonEmptyArray(values, `${path}.${field}`);
  values.forEach((value, i) => {
    assertEnumValue(value, allowedValues, `${path}.${field}[${i}]`);
    const reachable = reachableCategoriesOf(field, value);
    if (!reachable.some((category) => categories.includes(category))) {
      throw new DomainValidationError(
        `${path}.${field}[${i}]`,
        `"${value}" is only ever classified as ${reachable.join("/")}, so it can never match the queried "categories" (${categories.join("/")}) at evaluation time`,
      );
    }
  });
  return { [field]: values as readonly Value[] } as { readonly [K in Field]?: readonly Value[] };
}

export function createConditionDefinition(
  input: ConditionDefinitionInput,
  path: string,
  scope: TargetBindingScope | undefined,
): ConditionDefinition {
  assertEnumValue(input.kind, CONDITION_KINDS, `${path}.kind`);
  assertKnownKeys(input, CONDITION_ALLOWED_KEYS[input.kind], path);

  switch (input.kind) {
    case "TRUE":
      return { kind: "TRUE" };
    case "AND":
    case "OR": {
      const conditions = requireField(input, "conditions", path);
      assertNonEmptyArray(conditions, `${path}.conditions`);
      return {
        kind: input.kind,
        conditions: conditions.map((c, i) =>
          createConditionDefinition(c, `${path}.conditions[${i}]`, scope),
        ),
      };
    }
    case "NOT": {
      const condition = requireField(input, "condition", path);
      return {
        kind: "NOT",
        condition: createConditionDefinition(condition, `${path}.condition`, scope),
      };
    }
    case "TARGET_STATE": {
      const target = requireField(input, "target", path);
      const field = requireField(input, "field", path);
      assertEnumValue(field, TARGET_STATE_FIELDS, `${path}.field`);
      const value = requireField(input, "value", path);
      const expectedType = TARGET_STATE_FIELD_TYPES[field];
      if (typeof value !== expectedType) {
        throw new DomainValidationError(
          `${path}.value`,
          `must be of type ${expectedType} for field "${field}", got ${typeof value}`,
        );
      }
      return {
        kind: "TARGET_STATE",
        target: createTargetReference(target, `${path}.target`, scope),
        field,
        op: createOperator(input, path),
        value,
      };
    }
    case "TARGET_HAS_MARKER": {
      const target = requireField(input, "target", path);
      const markerId = createMarkerId(requireField(input, "markerId", path), `${path}.markerId`);
      const result: ConditionDefinition = {
        kind: "TARGET_HAS_MARKER",
        target: createTargetReference(target, `${path}.target`, scope),
        markerId,
      };
      if (input.countCondition === undefined) {
        return result;
      }
      assertKnownKeys(
        input.countCondition,
        MARKER_COUNT_CONDITION_ALLOWED_KEYS,
        `${path}.countCondition`,
      );
      assertEnumValue(input.countCondition.op, COMPARISON_OPERATORS, `${path}.countCondition.op`);
      assertFinite(input.countCondition.value, `${path}.countCondition.value`);
      return {
        ...result,
        countCondition: { op: input.countCondition.op, value: input.countCondition.value },
      };
    }
    case "EVENT_PAYLOAD":
    case "LAST_RESULT": {
      const field = requireField(input, "field", path);
      const value = requireField(input, "value", path);
      return { kind: input.kind, field, op: createOperator(input, path), value };
    }
    case "RUNTIME_COUNTER": {
      const counter = createRuntimeCounterId(
        requireField(input, "counter", path),
        `${path}.counter`,
      );
      const value = requireNumberField(input, path);
      const op = createOperator(input, path);
      if (input.modulo === undefined) {
        return { kind: "RUNTIME_COUNTER", counter, op, value };
      }
      assertInteger(input.modulo, `${path}.modulo`, { min: 1 });
      return { kind: "RUNTIME_COUNTER", counter, op, value, modulo: input.modulo };
    }
    case "TURN_NUMBER": {
      const value = requireNumberField(input, path);
      const op = createOperator(input, path);
      if (input.modulo === undefined) {
        return { kind: "TURN_NUMBER", op, value };
      }
      assertInteger(input.modulo, `${path}.modulo`, { min: 1 });
      return { kind: "TURN_NUMBER", op, value, modulo: input.modulo };
    }
    case "ALIVE_UNIT_COUNT": {
      const side = requireField(input, "side", path);
      assertEnumValue(side, SIDES, `${path}.side`);
      let excludeSelf = false;
      if (input.excludeSelf !== undefined) {
        assertBoolean(input.excludeSelf, `${path}.excludeSelf`);
        excludeSelf = input.excludeSelf;
      }
      const value = requireNumberField(input, path);
      return {
        kind: "ALIVE_UNIT_COUNT",
        side,
        excludeSelf,
        op: createOperator(input, path),
        value,
      };
    }
    case "POSITION_RELATION": {
      const target = requireField(input, "target", path);
      const relation = requireField(input, "relation", path);
      assertEnumValue(relation, POSITION_RELATIONS, `${path}.relation`);
      return {
        kind: "POSITION_RELATION",
        target: createTargetReference(target, `${path}.target`, scope),
        relation,
      };
    }
    case "RESOLUTION_PHASE": {
      const phase = requireField(input, "phase", path);
      assertEnumValue(phase, RESOLUTION_PHASES, `${path}.phase`);
      let negate = false;
      if (input.negate !== undefined) {
        assertBoolean(input.negate, `${path}.negate`);
        negate = input.negate;
      }
      return { kind: "RESOLUTION_PHASE", phase, negate };
    }
    case "TARGET_SET_COUNT": {
      const target = requireField(input, "target", path);
      const op = createOperator(input, path);
      const value = requireField(input, "value", path);
      if (typeof value !== "number") {
        throw new DomainValidationError(`${path}.value`, `must be a number, got ${typeof value}`);
      }
      assertInteger(value, `${path}.value`, { min: 0 });
      return {
        kind: "TARGET_SET_COUNT",
        target: createTargetReference(target, `${path}.target`, scope),
        op,
        value,
      };
    }
    case "TARGET_HAS_EFFECT": {
      const target = requireField(input, "target", path);
      const categories = requireField(input, "categories", path);
      assertNonEmptyArray(categories, `${path}.categories`);
      categories.forEach((category, i) =>
        assertEnumValue(category, TARGET_HAS_EFFECT_CATEGORIES, `${path}.categories[${i}]`),
      );
      const typedCategories = categories as readonly TargetHasEffectCategory[];
      return {
        kind: "TARGET_HAS_EFFECT",
        target: createTargetReference(target, `${path}.target`, scope),
        categories: typedCategories,
        ...createNarrowing(
          input,
          "continuousDamageKinds",
          CONTINUOUS_DAMAGE_KINDS,
          typedCategories,
          path,
        ),
        ...createNarrowing(input, "statKinds", STAT_KINDS, typedCategories, path),
      };
    }
  }
}
