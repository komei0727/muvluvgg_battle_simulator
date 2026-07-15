import { describe, expect, it } from "vitest";
import { createFormulaDefinition } from "./formula-definition.js";
import { DomainValidationError } from "../shared/errors.js";

describe("FormulaDefinition", () => {
  it("UT-CAT-FORM-001: maps a CONSTANT formula", () => {
    expect(createFormulaDefinition({ kind: "CONSTANT", value: 0.2 }, "formula", undefined)).toEqual(
      {
        kind: "CONSTANT",
        value: 0.2,
      },
    );
  });

  it("UT-CAT-FORM-002: maps a SKILL_POWER formula", () => {
    expect(
      createFormulaDefinition({ kind: "SKILL_POWER", power: 1.56 }, "formula", undefined),
    ).toEqual({
      kind: "SKILL_POWER",
      power: 1.56,
    });
  });

  it("UT-CAT-FORM-003: maps STAT_RATIO with a resolved BINDING source in scope", () => {
    const scope = new Set(["TGT_MAIN"]);
    const result = createFormulaDefinition(
      {
        kind: "STAT_RATIO",
        source: { kind: "BINDING", targetBindingId: "TGT_MAIN" },
        stat: "ATTACK",
        ratio: 1.5,
      },
      "formula",
      scope,
    );
    expect(result).toEqual({
      kind: "STAT_RATIO",
      source: { kind: "BINDING", targetBindingId: "TGT_MAIN" },
      stat: "ATTACK",
      ratio: 1.5,
    });
  });

  it("UT-CAT-FORM-004: rejects a BINDING source absent from scope", () => {
    const scope = new Set(["TGT_OTHER"]);
    expect(() =>
      createFormulaDefinition(
        {
          kind: "STAT_RATIO",
          source: { kind: "BINDING", targetBindingId: "TGT_MAIN" },
          stat: "ATTACK",
          ratio: 1,
        },
        "formula",
        scope,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-FORM-005: does not existence-check BINDING sources when scope is undefined (standalone EffectActionDefinition)", () => {
    const result = createFormulaDefinition(
      {
        kind: "STAT_RATIO",
        source: { kind: "BINDING", targetBindingId: "TGT_ANYTHING" },
        stat: "ATTACK",
        ratio: 1,
      },
      "formula",
      undefined,
    );
    expect(result.kind).toBe("STAT_RATIO");
  });

  it("UT-CAT-FORM-006: maps nested MIN/MAX formulas", () => {
    const result = createFormulaDefinition(
      {
        kind: "MIN",
        formulas: [
          { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.9 },
          { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio: 1.5 },
        ],
      },
      "formula",
      undefined,
    );
    expect(result).toEqual({
      kind: "MIN",
      formulas: [
        { kind: "CURRENT_HP_RATIO", source: { kind: "TARGET" }, ratio: 0.9 },
        { kind: "STAT_RATIO", source: { kind: "SKILL_SOURCE" }, stat: "ATTACK", ratio: 1.5 },
      ],
    });
  });

  it("UT-CAT-FORM-007: maps CLAMP wrapping a nested formula", () => {
    const result = createFormulaDefinition(
      { kind: "CLAMP", formula: { kind: "CONSTANT", value: 5 }, min: 0, max: 3 },
      "formula",
      undefined,
    );
    expect(result).toEqual({
      kind: "CLAMP",
      formula: { kind: "CONSTANT", value: 5 },
      min: 0,
      max: 3,
    });
  });

  it("UT-CAT-FORM-008: rejects an empty SUM formulas array", () => {
    expect(() =>
      createFormulaDefinition({ kind: "SUM", formulas: [] }, "formula", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-FORM-009: rejects an unknown formula kind", () => {
    expect(() => createFormulaDefinition({ kind: "HP_RATIO_SCALE" }, "formula", undefined)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-FORM-010: rejects a non-finite value", () => {
    expect(() =>
      createFormulaDefinition({ kind: "CONSTANT", value: Number.NaN }, "formula", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-FORM-011: rejects a typo'd sibling key not valid for the given kind", () => {
    expect(() =>
      createFormulaDefinition(
        { kind: "CONSTANT", value: 1, typoField: "oops" } as never,
        "formula",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-FORM-012: maps DAMAGE_DEALT_RATIO with sourceResult LAST_DAMAGE_DEALT", () => {
    const result = createFormulaDefinition(
      { kind: "DAMAGE_DEALT_RATIO", sourceResult: "LAST_DAMAGE_DEALT", ratio: 0.6 },
      "formula",
      undefined,
    );
    expect(result).toEqual({
      kind: "DAMAGE_DEALT_RATIO",
      sourceResult: "LAST_DAMAGE_DEALT",
      ratio: 0.6,
    });
  });

  it("UT-CAT-FORM-013: maps DAMAGE_DEALT_RATIO with sourceResult SUM_DAMAGE_DEALT (G-10, Issue #44: sums every DAMAGE result produced so far in the current EffectSequence, not just the immediately preceding one)", () => {
    const result = createFormulaDefinition(
      { kind: "DAMAGE_DEALT_RATIO", sourceResult: "SUM_DAMAGE_DEALT", ratio: 0.6 },
      "formula",
      undefined,
    );
    expect(result).toEqual({
      kind: "DAMAGE_DEALT_RATIO",
      sourceResult: "SUM_DAMAGE_DEALT",
      ratio: 0.6,
    });
  });

  it("UT-CAT-FORM-014: maps DAMAGE_RECEIVED_RATIO with sourceResult SUM_DAMAGE_RECEIVED", () => {
    const result = createFormulaDefinition(
      { kind: "DAMAGE_RECEIVED_RATIO", sourceResult: "SUM_DAMAGE_RECEIVED", ratio: 0.5 },
      "formula",
      undefined,
    );
    expect(result).toEqual({
      kind: "DAMAGE_RECEIVED_RATIO",
      sourceResult: "SUM_DAMAGE_RECEIVED",
      ratio: 0.5,
    });
  });

  it("UT-CAT-FORM-015: rejects an unknown sourceResult", () => {
    expect(() =>
      createFormulaDefinition(
        { kind: "DAMAGE_DEALT_RATIO", sourceResult: "ALL_TIME_DAMAGE_DEALT", ratio: 0.6 },
        "formula",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });
});
