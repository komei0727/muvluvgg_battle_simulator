import { describe, expect, it } from "vitest";
import { createConditionDefinition } from "./condition-definition.js";
import { DomainValidationError } from "../shared/errors.js";

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
});
