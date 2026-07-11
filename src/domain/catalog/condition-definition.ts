import type { ComparisonOperator } from "./catalog-enums.js";
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
import { DomainValidationError } from "../shared/errors.js";
import { assertEnumValue, assertFinite } from "../shared/validate.js";

export type JsonPrimitive = string | number | boolean;

const COMPARISON_OPERATORS = ["GT", "GTE", "LT", "LTE", "EQ", "NEQ", "IN", "CONTAINS"] as const;

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
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

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
    }
  | {
      readonly kind: "TURN_NUMBER";
      readonly op: ComparisonOperator;
      readonly value: number;
      readonly modulo?: number;
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

  switch (input.kind) {
    case "TRUE":
      return { kind: "TRUE" };
    case "AND":
    case "OR": {
      const conditions = requireField(input, "conditions", path);
      if (conditions.length === 0) {
        throw new DomainValidationError(`${path}.conditions`, "must contain at least one element");
      }
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
      return { kind: "RUNTIME_COUNTER", counter, op: createOperator(input, path), value };
    }
    case "TURN_NUMBER": {
      const value = requireNumberField(input, path);
      const op = createOperator(input, path);
      if (input.modulo === undefined) {
        return { kind: "TURN_NUMBER", op, value };
      }
      assertFinite(input.modulo, `${path}.modulo`);
      return { kind: "TURN_NUMBER", op, value, modulo: input.modulo };
    }
  }
}
