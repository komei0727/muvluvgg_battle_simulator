import type {
  Attribute,
  PositionColumn,
  PositionRow,
  Role,
  UnitType,
  ComparisonOperator,
  Side,
} from "./catalog-enums.js";
import { createMarkerId, type MarkerId } from "./catalog-ids.js";
import {
  createTargetReference,
  type TargetBindingScope,
  type TargetReference,
  type TargetReferenceInput,
} from "./references.js";
import { DomainValidationError } from "../shared/errors.js";
import {
  assertArray,
  assertBoolean,
  assertEnumValue,
  assertFinite,
  assertKnownKeys,
  assertNonEmptyArray,
} from "../shared/validate.js";

const COMPARISON_OPERATORS = ["GT", "GTE", "LT", "LTE", "EQ", "NEQ", "IN", "CONTAINS"] as const;
const SIDES = ["ALLY", "ENEMY", "ALL"] as const;
const ATTRIBUTES = ["AGGRESSIVE", "SHY", "CUTE", "SMART", "COMICAL", "CLEVER"] as const;
const UNIT_TYPES = ["PHYSICAL", "ENERGY", "AGILE"] as const;
const ROLES = ["PHYSICAL_ATTACKER", "EN_ATTACKER", "TANK", "SUPPORT", "CONTROL"] as const;
const POSITION_ROWS = ["FRONT", "BACK"] as const;
const POSITION_COLUMNS = ["LEFT", "CENTER", "RIGHT"] as const;
const TARGET_ORDER_KEYS = [
  "DEFAULT",
  "NEAREST",
  "FARTHEST",
  "LOWEST_HP_RATIO",
  "HIGHEST_HP_RATIO",
  "HIGHEST_ATTACK",
  "LOWEST_MAX_HP",
  "HIGHEST_EX_GAUGE_RATIO",
  "FRONT_ROW",
  "BACK_ROW",
  "LEFT_TO_RIGHT",
] as const;
export type TargetOrderKey = (typeof TARGET_ORDER_KEYS)[number];

// ---- TargetFilterDefinition ----

const TARGET_FILTER_KINDS = [
  "POSITION_ROW",
  "POSITION_COLUMN",
  "POSITION_SLOT",
  "UNIT_TYPE",
  "ROLE",
  "ATTRIBUTE",
  "AFFILIATION",
  "CHARACTER",
  "HAS_MARKER",
  "HP_RATIO",
  "AND",
  "OR",
  "NOT",
] as const;

export type TargetFilterDefinition =
  | { readonly kind: "POSITION_ROW"; readonly row: PositionRow }
  | { readonly kind: "POSITION_COLUMN"; readonly column: PositionColumn }
  | { readonly kind: "POSITION_SLOT"; readonly row: PositionRow; readonly column: PositionColumn }
  | { readonly kind: "UNIT_TYPE"; readonly unitType: UnitType }
  | { readonly kind: "ROLE"; readonly role: Role }
  | { readonly kind: "ATTRIBUTE"; readonly attribute: Attribute }
  | { readonly kind: "AFFILIATION"; readonly affiliationId: string }
  | { readonly kind: "CHARACTER"; readonly characterId: string }
  | { readonly kind: "HAS_MARKER"; readonly markerId: MarkerId }
  | { readonly kind: "HP_RATIO"; readonly op: ComparisonOperator; readonly value: number }
  | { readonly kind: "AND" | "OR"; readonly conditions: readonly TargetFilterDefinition[] }
  | { readonly kind: "NOT"; readonly condition: TargetFilterDefinition };

const TARGET_FILTER_ALLOWED_KEYS: Record<(typeof TARGET_FILTER_KINDS)[number], readonly string[]> =
  {
    POSITION_ROW: ["kind", "row"],
    POSITION_COLUMN: ["kind", "column"],
    POSITION_SLOT: ["kind", "row", "column"],
    UNIT_TYPE: ["kind", "unitType"],
    ROLE: ["kind", "role"],
    ATTRIBUTE: ["kind", "attribute"],
    AFFILIATION: ["kind", "affiliationId"],
    CHARACTER: ["kind", "characterId"],
    HAS_MARKER: ["kind", "markerId"],
    HP_RATIO: ["kind", "op", "value"],
    AND: ["kind", "conditions"],
    OR: ["kind", "conditions"],
    NOT: ["kind", "condition"],
  };

export interface TargetFilterDefinitionInput {
  readonly kind: string;
  readonly row?: string;
  readonly column?: string;
  readonly unitType?: string;
  readonly role?: string;
  readonly attribute?: string;
  readonly affiliationId?: string;
  readonly characterId?: string;
  readonly markerId?: string;
  readonly op?: string;
  readonly value?: number;
  readonly conditions?: readonly TargetFilterDefinitionInput[];
  readonly condition?: TargetFilterDefinitionInput;
}

function requireStringField(value: string | undefined, path: string): string {
  if (value === undefined) {
    throw new DomainValidationError(path, "is required");
  }
  return value;
}

export function createTargetFilterDefinition(
  input: TargetFilterDefinitionInput,
  path: string,
): TargetFilterDefinition {
  assertEnumValue(input.kind, TARGET_FILTER_KINDS, `${path}.kind`);
  assertKnownKeys(input, TARGET_FILTER_ALLOWED_KEYS[input.kind], path);
  switch (input.kind) {
    case "POSITION_ROW": {
      const row = requireStringField(input.row, `${path}.row`);
      assertEnumValue(row, POSITION_ROWS, `${path}.row`);
      return { kind: "POSITION_ROW", row };
    }
    case "POSITION_COLUMN": {
      const column = requireStringField(input.column, `${path}.column`);
      assertEnumValue(column, POSITION_COLUMNS, `${path}.column`);
      return { kind: "POSITION_COLUMN", column };
    }
    case "POSITION_SLOT": {
      const row = requireStringField(input.row, `${path}.row`);
      assertEnumValue(row, POSITION_ROWS, `${path}.row`);
      const column = requireStringField(input.column, `${path}.column`);
      assertEnumValue(column, POSITION_COLUMNS, `${path}.column`);
      return { kind: "POSITION_SLOT", row, column };
    }
    case "UNIT_TYPE": {
      const unitType = requireStringField(input.unitType, `${path}.unitType`);
      assertEnumValue(unitType, UNIT_TYPES, `${path}.unitType`);
      return { kind: "UNIT_TYPE", unitType };
    }
    case "ROLE": {
      const role = requireStringField(input.role, `${path}.role`);
      assertEnumValue(role, ROLES, `${path}.role`);
      return { kind: "ROLE", role };
    }
    case "ATTRIBUTE": {
      const attribute = requireStringField(input.attribute, `${path}.attribute`);
      assertEnumValue(attribute, ATTRIBUTES, `${path}.attribute`);
      return { kind: "ATTRIBUTE", attribute };
    }
    case "AFFILIATION":
      return {
        kind: "AFFILIATION",
        affiliationId: requireStringField(input.affiliationId, `${path}.affiliationId`),
      };
    case "CHARACTER":
      return {
        kind: "CHARACTER",
        characterId: requireStringField(input.characterId, `${path}.characterId`),
      };
    case "HAS_MARKER":
      return {
        kind: "HAS_MARKER",
        markerId: createMarkerId(
          requireStringField(input.markerId, `${path}.markerId`),
          `${path}.markerId`,
        ),
      };
    case "HP_RATIO": {
      const op = requireStringField(input.op, `${path}.op`);
      assertEnumValue(op, COMPARISON_OPERATORS, `${path}.op`);
      if (input.value === undefined) {
        throw new DomainValidationError(`${path}.value`, "is required");
      }
      assertFinite(input.value, `${path}.value`);
      return { kind: "HP_RATIO", op, value: input.value };
    }
    case "AND":
    case "OR": {
      const conditions = input.conditions;
      if (conditions === undefined) {
        throw new DomainValidationError(`${path}.conditions`, "is required");
      }
      assertNonEmptyArray(conditions, `${path}.conditions`);
      return {
        kind: input.kind,
        conditions: conditions.map((c, i) =>
          createTargetFilterDefinition(c, `${path}.conditions[${i}]`),
        ),
      };
    }
    case "NOT": {
      if (input.condition === undefined) {
        throw new DomainValidationError(`${path}.condition`, "is required");
      }
      return {
        kind: "NOT",
        condition: createTargetFilterDefinition(input.condition, `${path}.condition`),
      };
    }
  }
}

// ---- AreaDefinition ----

const AREA_KINDS = [
  "SINGLE",
  "ALL",
  "ROW",
  "COLUMN",
  "SAME_ROW_AS_BASE",
  "SAME_COLUMN_AS_BASE",
  "ADJACENT_ORTHOGONAL",
  "DIRECTLY_AHEAD_OF_BASE",
  "BEHIND_BASE",
] as const;

export type AreaDefinition =
  | {
      readonly kind:
        | "SINGLE"
        | "ALL"
        | "ADJACENT_ORTHOGONAL"
        | "DIRECTLY_AHEAD_OF_BASE"
        | "BEHIND_BASE";
    }
  | { readonly kind: "ROW"; readonly row: PositionRow }
  | { readonly kind: "COLUMN"; readonly column: PositionColumn }
  | { readonly kind: "SAME_ROW_AS_BASE" | "SAME_COLUMN_AS_BASE"; readonly includeBase: boolean };

export interface AreaDefinitionInput {
  readonly kind: string;
  readonly row?: string;
  readonly column?: string;
  readonly includeBase?: boolean;
}

const AREA_ALLOWED_KEYS: Record<(typeof AREA_KINDS)[number], readonly string[]> = {
  SINGLE: ["kind"],
  ALL: ["kind"],
  ADJACENT_ORTHOGONAL: ["kind"],
  DIRECTLY_AHEAD_OF_BASE: ["kind"],
  BEHIND_BASE: ["kind"],
  ROW: ["kind", "row"],
  COLUMN: ["kind", "column"],
  SAME_ROW_AS_BASE: ["kind", "includeBase"],
  SAME_COLUMN_AS_BASE: ["kind", "includeBase"],
};

export function createAreaDefinition(input: AreaDefinitionInput, path: string): AreaDefinition {
  assertEnumValue(input.kind, AREA_KINDS, `${path}.kind`);
  assertKnownKeys(input, AREA_ALLOWED_KEYS[input.kind], path);
  switch (input.kind) {
    case "SINGLE":
    case "ALL":
    case "ADJACENT_ORTHOGONAL":
    case "DIRECTLY_AHEAD_OF_BASE":
    case "BEHIND_BASE":
      return { kind: input.kind };
    case "ROW": {
      const row = requireStringField(input.row, `${path}.row`);
      assertEnumValue(row, POSITION_ROWS, `${path}.row`);
      return { kind: "ROW", row };
    }
    case "COLUMN": {
      const column = requireStringField(input.column, `${path}.column`);
      assertEnumValue(column, POSITION_COLUMNS, `${path}.column`);
      return { kind: "COLUMN", column };
    }
    case "SAME_ROW_AS_BASE":
    case "SAME_COLUMN_AS_BASE": {
      let includeBase = false;
      if (input.includeBase !== undefined) {
        assertBoolean(input.includeBase, `${path}.includeBase`);
        includeBase = input.includeBase;
      }
      return { kind: input.kind, includeBase };
    }
  }
}

// ---- TargetSelectorDefinition ----

const TARGET_SELECTOR_KINDS = [
  "SELECT",
  "SELF",
  "TRIGGER_SOURCE",
  "TRIGGER_TARGET",
  "BINDING_DERIVED",
] as const;

export interface TargetSelectorDefinition {
  readonly kind: (typeof TARGET_SELECTOR_KINDS)[number];
  readonly side?: Side;
  readonly count?: number | "ALL";
  readonly filters: readonly TargetFilterDefinition[];
  readonly order: readonly TargetOrderKey[];
  readonly area?: AreaDefinition;
  readonly base?: TargetReference;
  readonly fallback?: TargetSelectorDefinition;
  readonly includeDefeated: boolean;
}

export interface TargetSelectorDefinitionInput {
  readonly kind: string;
  readonly side?: string;
  readonly count?: number | "ALL";
  readonly filters?: readonly TargetFilterDefinitionInput[];
  readonly order?: readonly string[];
  readonly area?: AreaDefinitionInput;
  readonly base?: TargetReferenceInput;
  readonly fallback?: TargetSelectorDefinitionInput;
  readonly includeDefeated?: boolean;
}

/**
 * `side` and other fields can legitimately co-occur across every
 * `TargetSelectorDefinition` kind (e.g. `side` on `TRIGGER_SOURCE`), so this
 * is a single fixed set rather than a per-kind lookup like `TargetFilterDefinition`.
 */
const TARGET_SELECTOR_ALLOWED_KEYS = [
  "kind",
  "side",
  "count",
  "filters",
  "order",
  "area",
  "base",
  "fallback",
  "includeDefeated",
] as const;

export function createTargetSelectorDefinition(
  input: TargetSelectorDefinitionInput,
  path: string,
  scope: TargetBindingScope | undefined,
): TargetSelectorDefinition {
  assertEnumValue(input.kind, TARGET_SELECTOR_KINDS, `${path}.kind`);
  assertKnownKeys(input, TARGET_SELECTOR_ALLOWED_KEYS, path);

  if (input.filters !== undefined) {
    assertArray(input.filters, `${path}.filters`);
  }
  const filters = (input.filters ?? []).map((f, i) =>
    createTargetFilterDefinition(f, `${path}.filters[${i}]`),
  );
  if (input.order !== undefined) {
    assertArray(input.order, `${path}.order`);
  }
  const order = input.order ?? ["DEFAULT"];
  for (const [i, key] of order.entries()) {
    assertEnumValue(key, TARGET_ORDER_KEYS, `${path}.order[${i}]`);
  }

  let includeDefeated = false;
  if (input.includeDefeated !== undefined) {
    assertBoolean(input.includeDefeated, `${path}.includeDefeated`);
    includeDefeated = input.includeDefeated;
  }

  const result: {
    kind: (typeof TARGET_SELECTOR_KINDS)[number];
    side?: Side;
    count?: number | "ALL";
    filters: readonly TargetFilterDefinition[];
    order: readonly TargetOrderKey[];
    area?: AreaDefinition;
    base?: TargetReference;
    fallback?: TargetSelectorDefinition;
    includeDefeated: boolean;
  } = {
    kind: input.kind,
    filters,
    order: order as readonly TargetOrderKey[],
    includeDefeated,
  };

  if (input.kind === "SELECT") {
    const side = requireStringField(input.side, `${path}.side`);
    assertEnumValue(side, SIDES, `${path}.side`);
    result.side = side;
    if (input.count === undefined) {
      throw new DomainValidationError(`${path}.count`, "is required when kind is SELECT");
    }
    if (input.count !== "ALL") {
      assertFinite(input.count, `${path}.count`);
      if (!Number.isInteger(input.count) || input.count < 1) {
        throw new DomainValidationError(
          `${path}.count`,
          `must be a positive integer or "ALL", got ${input.count}`,
        );
      }
    }
    result.count = input.count;
  } else {
    if (input.count !== undefined) {
      throw new DomainValidationError(
        `${path}.count`,
        `must not be set when kind is "${input.kind}" (only valid when kind is SELECT)`,
      );
    }
    if (input.side !== undefined) {
      assertEnumValue(input.side, SIDES, `${path}.side`);
      result.side = input.side;
    }
  }

  if (input.kind === "BINDING_DERIVED") {
    if (input.base === undefined) {
      throw new DomainValidationError(`${path}.base`, "is required when kind is BINDING_DERIVED");
    }
    result.base = createTargetReference(input.base, `${path}.base`, scope);
  } else if (input.base !== undefined) {
    throw new DomainValidationError(
      `${path}.base`,
      `must not be set when kind is "${input.kind}" (only valid when kind is BINDING_DERIVED)`,
    );
  }

  if (input.area !== undefined) {
    result.area = createAreaDefinition(input.area, `${path}.area`);
  }

  if (input.fallback !== undefined) {
    result.fallback = createTargetSelectorDefinition(input.fallback, `${path}.fallback`, scope);
  }

  return result;
}
