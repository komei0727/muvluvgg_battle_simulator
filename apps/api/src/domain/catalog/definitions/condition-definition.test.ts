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

  it("UT-CAT-COND-028 (review [P2]): rejects a zero modulo on TURN_NUMBER", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "TURN_NUMBER", op: "EQ", value: 0, modulo: 0 },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-029 (review [P2]): rejects a negative modulo on TURN_NUMBER", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "TURN_NUMBER", op: "EQ", value: 0, modulo: -2 },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-030 (review [P2]): rejects a non-integer modulo on TURN_NUMBER", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "TURN_NUMBER", op: "EQ", value: 0, modulo: 1.5 },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
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

  it("UT-CAT-COND-031: maps a TARGET_SET_COUNT condition referencing a BINDING declared in scope (RES-004後半, Issue #227)", () => {
    const scope = new Set(["TGT_COLUMNS"]);
    const result = createConditionDefinition(
      {
        kind: "TARGET_SET_COUNT",
        target: { kind: "BINDING", targetBindingId: "TGT_COLUMNS" },
        op: "GTE",
        value: 1,
      },
      "condition",
      scope,
    );
    expect(result).toEqual({
      kind: "TARGET_SET_COUNT",
      target: { kind: "BINDING", targetBindingId: "TGT_COLUMNS" },
      op: "GTE",
      value: 1,
    });
  });

  it("UT-CAT-COND-032: maps a TARGET_SET_COUNT condition referencing SELF/TRIGGER_SOURCE-style non-BINDING targets", () => {
    const result = createConditionDefinition(
      { kind: "TARGET_SET_COUNT", target: { kind: "TRIGGER_TARGET" }, op: "LT", value: 1 },
      "condition",
      undefined,
    );
    expect(result).toEqual({
      kind: "TARGET_SET_COUNT",
      target: { kind: "TRIGGER_TARGET" },
      op: "LT",
      value: 1,
    });
  });

  it("UT-CAT-COND-033: rejects a negative value on TARGET_SET_COUNT", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_SET_COUNT",
          target: { kind: "TRIGGER_TARGET" },
          op: "GTE",
          value: -1,
        },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-034: rejects a non-integer value on TARGET_SET_COUNT", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_SET_COUNT",
          target: { kind: "TRIGGER_TARGET" },
          op: "GTE",
          value: 1.5,
        },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-035: rejects a typo'd sibling key on TARGET_SET_COUNT", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_SET_COUNT",
          target: { kind: "TRIGGER_TARGET" },
          op: "GTE",
          value: 1,
          typoField: 1,
        } as never,
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-036: rejects a TARGET_SET_COUNT BINDING target outside the declared scope", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_SET_COUNT",
          target: { kind: "BINDING", targetBindingId: "TGT_UNKNOWN" },
          op: "GTE",
          value: 1,
        },
        "condition",
        new Set(["TGT_COLUMNS"]),
      ),
    ).toThrow(DomainValidationError);
  });
});

/**
 * M7-001E（Issue #248、`TARGET_STATE_QUERY_BUFF_DEBUFF`、`CAP_TARGET_EFFECT_QUERY`）:
 * 「対象が何らかのバフ／デバフ／状態異常を保持しているか」を、R-EFF-02/03の
 * 分類軸（`EffectImmunityCategory`）で照会する`TARGET_HAS_EFFECT`。絞り込み
 * （`statusKinds`/`continuousDamageKinds`/`statKinds`）は`REMOVE_EFFECTS`／
 * `EFFECT_IMMUNITY`のselector形と同じく、カテゴリ一致にANDで重ねる。
 */
describe("createConditionDefinition (TARGET_HAS_EFFECT)", () => {
  it("UT-CAT-COND-037: maps a bare category query, defaulting every narrowing filter to absent", () => {
    const result = createConditionDefinition(
      {
        kind: "TARGET_HAS_EFFECT",
        target: { kind: "BINDING", targetBindingId: "TGT_BASE" },
        categories: ["DEBUFF"],
      },
      "condition",
      new Set(["TGT_BASE"]),
    );

    expect(result).toEqual({
      kind: "TARGET_HAS_EFFECT",
      target: { kind: "BINDING", targetBindingId: "TGT_BASE" },
      categories: ["DEBUFF"],
    });
  });

  it("UT-CAT-COND-038: maps both narrowing filters (continuousDamageKinds / statKinds)", () => {
    const result = createConditionDefinition(
      {
        kind: "TARGET_HAS_EFFECT",
        target: { kind: "SELF" },
        categories: ["DEBUFF"],
        continuousDamageKinds: ["POISON"],
        statKinds: ["ATTACK"],
      },
      "condition",
      undefined,
    );

    expect(result).toEqual({
      kind: "TARGET_HAS_EFFECT",
      target: { kind: "SELF" },
      categories: ["DEBUFF"],
      continuousDamageKinds: ["POISON"],
      statKinds: ["ATTACK"],
    });
  });

  it("UT-CAT-COND-039: rejects an empty categories array (a query that can never match)", () => {
    expect(() =>
      createConditionDefinition(
        { kind: "TARGET_HAS_EFFECT", target: { kind: "SELF" }, categories: [] },
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-COND-040: rejects MARKER and SPECIFIC_EFFECT categories, which TARGET_HAS_MARKER and a definition-id match own instead", () => {
    for (const category of ["MARKER", "SPECIFIC_EFFECT"]) {
      expect(() =>
        createConditionDefinition(
          { kind: "TARGET_HAS_EFFECT", target: { kind: "SELF" }, categories: [category] },
          "condition",
          undefined,
        ),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-CAT-COND-041: rejects an unknown or empty value in any narrowing filter", () => {
    for (const narrowing of [
      { continuousDamageKinds: ["NOT_A_DOT"] },
      { statKinds: ["NOT_A_STAT"] },
      { continuousDamageKinds: [] },
      { statKinds: [] },
    ]) {
      expect(() =>
        createConditionDefinition(
          {
            kind: "TARGET_HAS_EFFECT",
            target: { kind: "SELF" },
            categories: ["DEBUFF"],
            ...narrowing,
          },
          "condition",
          undefined,
        ),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-CAT-COND-042: rejects a narrowing filter that its categories can never reach", () => {
    // `continuousDamageKinds`は`APPLY_CONTINUOUS_DAMAGE`（常に`DEBUFF`）だけが、
    // `statKinds`は`APPLY_STAT_MOD`（符号で`BUFF`/`DEBUFF`）だけが持つ。`STATUS`や
    // `SHIELD`だけを問い合わせる条件へ重ねると実行時に一切一致しない「黙って効かない
    // 定義」になるため、`EFFECT_IMMUNITY.statusKinds`と同じ理由でロード時に拒否する。
    for (const narrowing of [{ continuousDamageKinds: ["POISON"] }, { statKinds: ["ATTACK"] }]) {
      expect(() =>
        createConditionDefinition(
          {
            kind: "TARGET_HAS_EFFECT",
            target: { kind: "SELF" },
            categories: ["SHIELD"],
            ...narrowing,
          },
          "condition",
          undefined,
        ),
      ).toThrow(DomainValidationError);
    }
  });

  it("UT-CAT-COND-043: rejects a typo'd sibling key and a BINDING target outside the declared scope", () => {
    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_HAS_EFFECT",
          target: { kind: "SELF" },
          categories: ["DEBUFF"],
          typoField: 1,
        } as never,
        "condition",
        undefined,
      ),
    ).toThrow(DomainValidationError);

    expect(() =>
      createConditionDefinition(
        {
          kind: "TARGET_HAS_EFFECT",
          target: { kind: "BINDING", targetBindingId: "TGT_UNKNOWN" },
          categories: ["DEBUFF"],
        },
        "condition",
        new Set(["TGT_BASE"]),
      ),
    ).toThrow(DomainValidationError);
  });
});
