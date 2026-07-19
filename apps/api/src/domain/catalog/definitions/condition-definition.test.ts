import { describe, expect, it } from "vitest";
import { createConditionDefinition } from "./condition-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

describe("ConditionDefinition", () => {
  it("UT-CAT-COND-001: maps a TRUE condition", () => {
    expect(createConditionDefinition({ kind: "TRUE" }, "condition", undefined)).toEqual({
      kind: "TRUE",
    });
  });

  it("UT-CAT-COND-002: maps a nested AND of TARGET_STATE conditions", () => {
    const result = createConditionDefinition(
      {
        kind: "AND",
        conditions: [
          {
            kind: "TARGET_STATE",
            target: { kind: "SELF" },
            field: "HP_RATIO",
            op: "LTE",
            value: 0.3,
          },
          {
            kind: "TARGET_STATE",
            target: { kind: "SELF" },
            field: "IS_ALIVE",
            op: "EQ",
            value: true,
          },
        ],
      },
      "condition",
      undefined,
    );
    expect(result).toEqual({
      kind: "AND",
      conditions: [
        {
          kind: "TARGET_STATE",
          target: { kind: "SELF" },
          field: "HP_RATIO",
          op: "LTE",
          value: 0.3,
        },
        {
          kind: "TARGET_STATE",
          target: { kind: "SELF" },
          field: "IS_ALIVE",
          op: "EQ",
          value: true,
        },
      ],
    });
  });

  it("UT-CAT-COND-003: rejects a TARGET_STATE value whose type mismatches the field", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_STATE",
          target: { kind: "SELF" },
          field: "IS_ALIVE",
          op: "EQ",
          value: "true",
        },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-004: rejects an empty AND conditions array", () => {
    expect(() =>
      createConditionDefinition({ kind: "AND", conditions: [] }, "condition", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-005: rejects an unknown condition kind", () => {
    expect(() => createConditionDefinition({ kind: "IMPOSSIBLE" }, "condition", undefined)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-COND-006: resolves a BINDING target reference declared in scope", () => {
    const scope = new Set(["TGT_PRIMARY"]);
    const result = createConditionDefinition(
      {
        kind: "TARGET_STATE",
        target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
        field: "IS_ALIVE",
        op: "EQ",
        value: true,
      },
      "condition",
      scope,
    );
    expect(result).toEqual({
      kind: "TARGET_STATE",
      target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
      field: "IS_ALIVE",
      op: "EQ",
      value: true,
    });
  });

  it("UT-CAT-COND-007: rejects a BINDING target reference absent from scope", () => {
    const scope = new Set(["TGT_OTHER"]);
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_STATE",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          field: "IS_ALIVE",
          op: "EQ",
          value: true,
        },
        "condition",
        scope,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-008: maps a RUNTIME_COUNTER condition", () => {
    const result = createConditionDefinition(
      { kind: "RUNTIME_COUNTER", counter: "ps-scope-1", op: "GTE", value: 2 },
      "condition",
      undefined,
    );
    expect(result).toEqual({ kind: "RUNTIME_COUNTER", counter: "ps-scope-1", op: "GTE", value: 2 });
  });

  it("UT-CAT-COND-009: maps a TURN_NUMBER condition with modulo", () => {
    const result = createConditionDefinition(
      { kind: "TURN_NUMBER", op: "EQ", value: 0, modulo: 3 },
      "condition",
      undefined,
    );
    expect(result).toEqual({ kind: "TURN_NUMBER", op: "EQ", value: 0, modulo: 3 });
  });

  it("UT-CAT-COND-010: rejects an invalid comparison operator", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "TURN_NUMBER", op: "ALMOST", value: 1 },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-011: rejects a typo'd sibling key not valid for the given kind", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "TRUE", typoField: "oops" } as never,
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-012: rejects a typo'd sibling key inside countCondition", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_HAS_MARKER",
          target: { kind: "SELF" },
          markerId: "MARKER_CURSE",
          countCondition: { op: "GTE", value: 2, typoField: 1 } as never,
        },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-013: maps ALIVE_UNIT_COUNT with excludeSelf defaulted to false (G-03, Issue #44)", () => {
    const result = createConditionDefinition(
      { kind: "ALIVE_UNIT_COUNT", side: "ALLY", op: "GT", value: 0 },
      "condition",
      undefined,
    );
    expect(result).toEqual({
      kind: "ALIVE_UNIT_COUNT",
      side: "ALLY",
      excludeSelf: false,
      op: "GT",
      value: 0,
    });
  });

  it("UT-CAT-COND-014: maps ALIVE_UNIT_COUNT with excludeSelf true (self excluded from the count)", () => {
    const result = createConditionDefinition(
      { kind: "ALIVE_UNIT_COUNT", side: "ALLY", excludeSelf: true, op: "GT", value: 0 },
      "condition",
      undefined,
    );
    expect(result).toEqual({
      kind: "ALIVE_UNIT_COUNT",
      side: "ALLY",
      excludeSelf: true,
      op: "GT",
      value: 0,
    });
  });

  it("UT-CAT-COND-015: rejects ALIVE_UNIT_COUNT with an unknown side", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "ALIVE_UNIT_COUNT", side: "SELF", op: "GT", value: 0 },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-016: rejects a typo'd sibling key on ALIVE_UNIT_COUNT", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "ALIVE_UNIT_COUNT", side: "ALLY", op: "GT", value: 0, typoField: 1 } as never,
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-017: maps a RUNTIME_COUNTER condition with modulo (Issue #143)", () => {
    const result = createConditionDefinition(
      {
        kind: "RUNTIME_COUNTER",
        counter: "RUNTIME_COUNTER_AS_USE",
        op: "GTE",
        value: 1,
        modulo: 3,
      },
      "condition",
      undefined,
    );
    expect(result).toEqual({
      kind: "RUNTIME_COUNTER",
      counter: "RUNTIME_COUNTER_AS_USE",
      op: "GTE",
      value: 1,
      modulo: 3,
    });
  });

  it("UT-CAT-COND-018: rejects a non-finite modulo on RUNTIME_COUNTER", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "RUNTIME_COUNTER",
          counter: "RUNTIME_COUNTER_AS_USE",
          op: "GTE",
          value: 1,
          modulo: Number.NaN,
        },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-019: rejects a zero or negative modulo on RUNTIME_COUNTER (Issue #143)", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "RUNTIME_COUNTER",
          counter: "RUNTIME_COUNTER_AS_USE",
          op: "GTE",
          value: 1,
          modulo: 0,
        },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-020: rejects a non-integer modulo on RUNTIME_COUNTER (Issue #143)", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "RUNTIME_COUNTER",
          counter: "RUNTIME_COUNTER_AS_USE",
          op: "GTE",
          value: 1,
          modulo: 1.5,
        },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-021: maps a POSITION_RELATION condition (Issue #144, TRIGGER_POSITION_RELATION)", () => {
    const result = createConditionDefinition(
      { kind: "POSITION_RELATION", target: { kind: "TRIGGER_TARGET" }, relation: "IN_FRONT_OF" },
      "condition",
      undefined,
    );
    expect(result).toEqual({
      kind: "POSITION_RELATION",
      target: { kind: "TRIGGER_TARGET" },
      relation: "IN_FRONT_OF",
    });
  });

  it("UT-CAT-COND-022: rejects POSITION_RELATION with an unknown relation", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "POSITION_RELATION", target: { kind: "TRIGGER_TARGET" }, relation: "BEHIND_OF" },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-023: rejects a typo'd sibling key on POSITION_RELATION", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "POSITION_RELATION",
          target: { kind: "TRIGGER_TARGET" },
          relation: "IN_FRONT_OF",
          typoField: 1,
        } as never,
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-024: maps a RESOLUTION_PHASE condition with negate defaulted to false (Issue #144, TRIGGER_EXCLUSION_TIMING)", () => {
    const result = createConditionDefinition(
      { kind: "RESOLUTION_PHASE", phase: "TURN_START" },
      "condition",
      undefined,
    );
    expect(result).toEqual({ kind: "RESOLUTION_PHASE", phase: "TURN_START", negate: false });
  });

  it("UT-CAT-COND-025: maps a RESOLUTION_PHASE condition with negate true (exclusion form)", () => {
    const result = createConditionDefinition(
      { kind: "RESOLUTION_PHASE", phase: "BATTLE_START", negate: true },
      "condition",
      undefined,
    );
    expect(result).toEqual({ kind: "RESOLUTION_PHASE", phase: "BATTLE_START", negate: true });
  });

  it("UT-CAT-COND-026: rejects RESOLUTION_PHASE with an unknown phase", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "RESOLUTION_PHASE", phase: "ACTION_START" },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-027: rejects a typo'd sibling key on RESOLUTION_PHASE", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "RESOLUTION_PHASE", phase: "TURN_END", typoField: 1 } as never,
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });
});
