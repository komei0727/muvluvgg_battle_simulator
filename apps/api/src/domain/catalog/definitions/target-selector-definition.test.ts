import { describe, expect, it } from "vitest";
import {
  createAreaDefinition,
  createTargetFilterDefinition,
  createTargetSelectorDefinition,
  type TargetFilterDefinitionInput,
} from "./target-selector-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

describe("TargetSelectorDefinition", () => {
  it("UT-CAT-TSEL-001: maps a SELECT selector with filters, order, and fallback", () => {
    const result = createTargetSelectorDefinition(
      {
        kind: "SELECT",
        side: "ENEMY",
        count: "ALL",
        filters: [{ kind: "POSITION_COLUMN", column: "RIGHT" }],
        fallback: {
          kind: "SELECT",
          side: "ENEMY",
          count: 1,
          order: ["NEAREST", "FRONT_ROW", "LEFT_TO_RIGHT"],
        },
      },
      "selector",
      undefined,
    );
    expect(result).toEqual({
      kind: "SELECT",
      side: "ENEMY",
      count: "ALL",
      filters: [{ kind: "POSITION_COLUMN", column: "RIGHT" }],
      order: ["DEFAULT"],
      includeDefeated: false,
      fallback: {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        filters: [],
        order: ["NEAREST", "FRONT_ROW", "LEFT_TO_RIGHT"],
        includeDefeated: false,
      },
    });
  });

  it("UT-CAT-TSEL-002: requires side and count when kind is SELECT", () => {
    expect(() => createTargetSelectorDefinition({ kind: "SELECT" }, "selector", undefined)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-TSEL-003: rejects count 0", () => {
    expect(() =>
      createTargetSelectorDefinition(
        { kind: "SELECT", side: "ENEMY", count: 0 },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-004: maps BINDING_DERIVED with a resolved base in scope", () => {
    const scope = new Set(["TGT_NEAREST"]);
    const result = createTargetSelectorDefinition(
      {
        kind: "BINDING_DERIVED",
        base: { kind: "BINDING", targetBindingId: "TGT_NEAREST" },
        area: { kind: "ADJACENT_ORTHOGONAL" },
      },
      "selector",
      scope,
    );
    expect(result.base).toEqual({ kind: "BINDING", targetBindingId: "TGT_NEAREST" });
    expect(result.area).toEqual({ kind: "ADJACENT_ORTHOGONAL" });
  });

  it("UT-CAT-TSEL-005: rejects BINDING_DERIVED without a base", () => {
    expect(() =>
      createTargetSelectorDefinition({ kind: "BINDING_DERIVED" }, "selector", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-006: rejects an unknown order key", () => {
    expect(() =>
      createTargetSelectorDefinition(
        { kind: "SELECT", side: "ENEMY", count: 1, order: ["CLOSEST"] },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-007: maps SAME_ROW_AS_BASE area with includeBase", () => {
    const result = createTargetSelectorDefinition(
      { kind: "SELF", area: { kind: "SAME_ROW_AS_BASE", includeBase: true } },
      "selector",
      undefined,
    );
    expect(result.area).toEqual({ kind: "SAME_ROW_AS_BASE", includeBase: true });
  });

  it("UT-CAT-TSEL-008: rejects a count that is not a positive integer", () => {
    expect(() =>
      createTargetSelectorDefinition(
        { kind: "SELECT", side: "ENEMY", count: 1.5 },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-009: maps TRIGGER_SOURCE/TRIGGER_TARGET/SELF selectors, optionally with side", () => {
    expect(
      createTargetSelectorDefinition({ kind: "SELF" }, "selector", undefined).side,
    ).toBeUndefined();
    expect(
      createTargetSelectorDefinition(
        { kind: "TRIGGER_SOURCE", side: "ALLY" },
        "selector",
        undefined,
      ).side,
    ).toBe("ALLY");
    expect(
      createTargetSelectorDefinition({ kind: "TRIGGER_TARGET" }, "selector", undefined).kind,
    ).toBe("TRIGGER_TARGET");
  });

  it("UT-CAT-TSEL-010: rejects an unknown side on a non-SELECT selector", () => {
    expect(() =>
      createTargetSelectorDefinition({ kind: "SELF", side: "BOTH" }, "selector", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-011: maps ROW and COLUMN areas", () => {
    expect(
      createTargetSelectorDefinition(
        { kind: "SELF", area: { kind: "ROW", row: "FRONT" } },
        "s",
        undefined,
      ).area,
    ).toEqual({
      kind: "ROW",
      row: "FRONT",
    });
    expect(
      createTargetSelectorDefinition(
        { kind: "SELF", area: { kind: "COLUMN", column: "LEFT" } },
        "s",
        undefined,
      ).area,
    ).toEqual({ kind: "COLUMN", column: "LEFT" });
  });

  it("UT-CAT-TSEL-012: maps every TargetFilterDefinition kind", () => {
    const cases: Array<[TargetFilterDefinitionInput, unknown]> = [
      [
        { kind: "POSITION_SLOT", row: "FRONT", column: "LEFT" },
        { kind: "POSITION_SLOT", row: "FRONT", column: "LEFT" },
      ],
      [
        { kind: "UNIT_TYPE", unitType: "PHYSICAL" },
        { kind: "UNIT_TYPE", unitType: "PHYSICAL" },
      ],
      [
        { kind: "ROLE", role: "TANK" },
        { kind: "ROLE", role: "TANK" },
      ],
      [
        { kind: "ATTRIBUTE", attribute: "CLEVER" },
        { kind: "ATTRIBUTE", attribute: "CLEVER" },
      ],
      [
        { kind: "AFFILIATION", affiliationId: "AFF_1" },
        { kind: "AFFILIATION", affiliationId: "AFF_1" },
      ],
      [
        { kind: "CHARACTER", characterId: "CHAR_1" },
        { kind: "CHARACTER", characterId: "CHAR_1" },
      ],
      [
        { kind: "HAS_MARKER", markerId: "MARKER_CURSE" },
        { kind: "HAS_MARKER", markerId: "MARKER_CURSE" },
      ],
      [
        { kind: "HP_RATIO", op: "LTE", value: 0.3 },
        { kind: "HP_RATIO", op: "LTE", value: 0.3 },
      ],
    ];
    for (const [input, expected] of cases) {
      expect(createTargetFilterDefinition(input, "filter")).toEqual(expected);
    }
  });

  it("UT-CAT-TSEL-013: maps AND/OR/NOT filter combinators", () => {
    const and = createTargetFilterDefinition(
      {
        kind: "AND",
        conditions: [
          { kind: "UNIT_TYPE", unitType: "PHYSICAL" },
          { kind: "ROLE", role: "TANK" },
        ],
      },
      "filter",
    );
    expect(and).toEqual({
      kind: "AND",
      conditions: [
        { kind: "UNIT_TYPE", unitType: "PHYSICAL" },
        { kind: "ROLE", role: "TANK" },
      ],
    });
    const not = createTargetFilterDefinition(
      { kind: "NOT", condition: { kind: "UNIT_TYPE", unitType: "ENERGY" } },
      "filter",
    );
    expect(not).toEqual({ kind: "NOT", condition: { kind: "UNIT_TYPE", unitType: "ENERGY" } });
  });

  it("UT-CAT-TSEL-014: rejects OR with no conditions and NOT with no condition", () => {
    expect(() => createTargetFilterDefinition({ kind: "OR" }, "filter")).toThrow(
      DomainValidationError,
    );
    expect(() => createTargetFilterDefinition({ kind: "NOT" }, "filter")).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-TSEL-015: rejects a malformed HAS_MARKER markerId", () => {
    expect(() =>
      createTargetFilterDefinition({ kind: "HAS_MARKER", markerId: "CURSE" }, "filter"),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-016: rejects a typo'd sibling key on a TargetFilterDefinition", () => {
    expect(() =>
      createTargetFilterDefinition(
        { kind: "POSITION_ROW", row: "FRONT", typoField: "oops" } as never,
        "filter",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-017: rejects a typo'd sibling key on an AreaDefinition", () => {
    expect(() =>
      createAreaDefinition({ kind: "SINGLE", typoField: "oops" } as never, "area"),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-018: rejects a typo'd sibling key on a TargetSelectorDefinition", () => {
    expect(() =>
      createTargetSelectorDefinition(
        { kind: "SELF", typoField: "oops" } as never,
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-019: rejects a stale count on a non-SELECT selector (SELF)", () => {
    expect(() =>
      createTargetSelectorDefinition({ kind: "SELF", count: 1 }, "selector", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-020: rejects a stale count on a non-SELECT selector (TRIGGER_SOURCE)", () => {
    expect(() =>
      createTargetSelectorDefinition({ kind: "TRIGGER_SOURCE", count: 1 }, "selector", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-021: still allows side to co-occur with a non-SELECT kind", () => {
    const result = createTargetSelectorDefinition(
      { kind: "TRIGGER_SOURCE", side: "ALLY" },
      "selector",
      undefined,
    );
    expect(result.side).toBe("ALLY");
  });

  it("UT-CAT-TSEL-022: rejects a stale base on a SELECT selector", () => {
    expect(() =>
      createTargetSelectorDefinition(
        { kind: "SELECT", side: "ENEMY", count: 1, base: { kind: "SELF" } },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-023: rejects a stale base on a SELF selector", () => {
    expect(() =>
      createTargetSelectorDefinition(
        { kind: "SELF", base: { kind: "SELF" } },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-024: maps HAS_MARKER with a countCondition (TARGET_FILTER_MARKER_COUNT_THRESHOLD)", () => {
    const result = createTargetFilterDefinition(
      {
        kind: "HAS_MARKER",
        markerId: "MARKER_CURSE",
        countCondition: { op: "GTE", value: 2 },
      },
      "filter",
    );
    expect(result).toEqual({
      kind: "HAS_MARKER",
      markerId: "MARKER_CURSE",
      countCondition: { op: "GTE", value: 2 },
    });
  });

  it("UT-CAT-TSEL-025: rejects a malformed HAS_MARKER countCondition", () => {
    expect(() =>
      createTargetFilterDefinition(
        { kind: "HAS_MARKER", markerId: "MARKER_CURSE", countCondition: { op: "GTE" } },
        "filter",
      ),
    ).toThrow(DomainValidationError);
    expect(() =>
      createTargetFilterDefinition(
        {
          kind: "HAS_MARKER",
          markerId: "MARKER_CURSE",
          countCondition: { op: "BOGUS", value: 2 },
        },
        "filter",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-026: maps EXCLUDE_RESOLVED_UNIT referencing SELF or an in-scope BINDING (TARGET_EXCLUDE_RESOLVED_UNIT)", () => {
    const self = createTargetFilterDefinition(
      { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } },
      "filter",
    );
    expect(self).toEqual({ kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "SELF" } });

    const scope = new Set(["TGT_PRIMARY"]);
    const binding = createTargetFilterDefinition(
      {
        kind: "EXCLUDE_RESOLVED_UNIT",
        reference: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
      },
      "filter",
      scope,
    );
    expect(binding).toEqual({
      kind: "EXCLUDE_RESOLVED_UNIT",
      reference: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
    });
  });

  it("UT-CAT-TSEL-027: rejects EXCLUDE_RESOLVED_UNIT referencing a BINDING outside scope", () => {
    expect(() =>
      createTargetFilterDefinition(
        { kind: "EXCLUDE_RESOLVED_UNIT", reference: { kind: "BINDING", targetBindingId: "TGT_X" } },
        "filter",
        new Set(["TGT_OTHER"]),
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-028: rejects EXCLUDE_RESOLVED_UNIT without a reference", () => {
    expect(() => createTargetFilterDefinition({ kind: "EXCLUDE_RESOLVED_UNIT" }, "filter")).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-TSEL-029: maps MARKER_IN_AREA (TARGET_FILTER_MARKER_BY_AREA)", () => {
    const result = createTargetFilterDefinition(
      {
        kind: "MARKER_IN_AREA",
        area: { kind: "SAME_COLUMN_AS_BASE", includeBase: true },
        markerId: "MARKER_CLARA_SANTA_TAG",
      },
      "filter",
    );
    expect(result).toEqual({
      kind: "MARKER_IN_AREA",
      area: { kind: "SAME_COLUMN_AS_BASE", includeBase: true },
      markerId: "MARKER_CLARA_SANTA_TAG",
    });
  });

  it("UT-CAT-TSEL-030: rejects MARKER_IN_AREA without an area", () => {
    expect(() =>
      createTargetFilterDefinition(
        { kind: "MARKER_IN_AREA", markerId: "MARKER_CLARA_SANTA_TAG" },
        "filter",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-031: maps a MARKER_COUNT order entry (TARGET_ORDER_MARKER_COUNT)", () => {
    const result = createTargetSelectorDefinition(
      {
        kind: "SELECT",
        side: "ENEMY",
        count: 1,
        order: [
          { kind: "MARKER_COUNT", markerId: "MARKER_DOROTHEA_PIONEER_GRACE", direction: "ASC" },
        ],
      },
      "selector",
      undefined,
    );
    expect(result.order).toEqual([
      { kind: "MARKER_COUNT", markerId: "MARKER_DOROTHEA_PIONEER_GRACE", direction: "ASC" },
    ]);
  });

  it("UT-CAT-TSEL-032: rejects a MARKER_COUNT order entry with an invalid direction", () => {
    expect(() =>
      createTargetSelectorDefinition(
        {
          kind: "SELECT",
          side: "ENEMY",
          count: 1,
          order: [{ kind: "MARKER_COUNT", markerId: "MARKER_X", direction: "SIDEWAYS" }],
        },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-033: maps a UNIT_TYPE_PRIORITY order entry (TARGET_ORDER_UNITTYPE_OR_SELF_EXCLUDE)", () => {
    const result = createTargetSelectorDefinition(
      {
        kind: "SELECT",
        side: "ALLY",
        count: 1,
        order: [{ kind: "UNIT_TYPE_PRIORITY", unitType: "ENERGY" }, "SELF_LOWEST_PRIORITY"],
      },
      "selector",
      undefined,
    );
    expect(result.order).toEqual([
      { kind: "UNIT_TYPE_PRIORITY", unitType: "ENERGY" },
      "SELF_LOWEST_PRIORITY",
    ]);
  });

  it("UT-CAT-TSEL-034: rejects an order entry object with an unknown kind", () => {
    expect(() =>
      createTargetSelectorDefinition(
        { kind: "SELECT", side: "ENEMY", count: 1, order: [{ kind: "BOGUS" }] },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-035: rejects a typo'd sibling key on a MARKER_COUNT order entry", () => {
    expect(() =>
      createTargetSelectorDefinition(
        {
          kind: "SELECT",
          side: "ENEMY",
          count: 1,
          order: [
            {
              kind: "MARKER_COUNT",
              markerId: "MARKER_X",
              direction: "ASC",
              typoField: "oops",
            } as never,
          ],
        },
        "selector",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TSEL-036: HIGHEST_MAX_HP and FASTEST are valid order keys (TARGET_ORDER_STAT_LOWEST_OR_SPEED)", () => {
    const result = createTargetSelectorDefinition(
      { kind: "SELECT", side: "ENEMY", count: 1, order: ["HIGHEST_MAX_HP", "FASTEST"] },
      "selector",
      undefined,
    );
    expect(result.order).toEqual(["HIGHEST_MAX_HP", "FASTEST"]);
  });
});
