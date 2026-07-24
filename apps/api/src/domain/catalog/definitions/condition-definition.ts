import type { ComparisonOperator, Side } from "./catalog-enums.js";
import {
  createMarkerId,
  createRuntimeCounterId,
  type MarkerId,
  type RuntimeCounterId,
} from "./catalog-ids.js";
import {
  createTargetReference,
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

const TARGET_STATE_FIELD_TYPES: Record<TargetStateField, "boolean" | "number" | "string"> = {
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
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

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
  }
}
