import { describe, expect, it } from "vitest";
import { createFormulaSourceReference, createTargetReference } from "./references.js";
import { DomainValidationError } from "../shared/errors.js";

describe("References", () => {
  it("UT-CAT-REF-001: maps a SELF TargetReference", () => {
    expect(createTargetReference({ kind: "SELF" }, "ref", undefined)).toEqual({ kind: "SELF" });
  });

  it("UT-CAT-REF-002: resolves a BINDING TargetReference declared in scope", () => {
    const scope = new Set(["TGT_PRIMARY"]);
    expect(
      createTargetReference({ kind: "BINDING", targetBindingId: "TGT_PRIMARY" }, "ref", scope),
    ).toEqual({
      kind: "BINDING",
      targetBindingId: "TGT_PRIMARY",
    });
  });

  it("UT-CAT-REF-003: rejects a typo'd sibling key on a TargetReference", () => {
    expect(() =>
      createTargetReference({ kind: "SELF", typoField: "oops" } as never, "ref", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-REF-004: maps a SKILL_SOURCE FormulaSourceReference", () => {
    expect(createFormulaSourceReference({ kind: "SKILL_SOURCE" }, "ref", undefined)).toEqual({
      kind: "SKILL_SOURCE",
    });
  });

  it("UT-CAT-REF-005: rejects a typo'd sibling key on a FormulaSourceReference", () => {
    expect(() =>
      createFormulaSourceReference(
        { kind: "TARGET", typoField: "oops" } as never,
        "ref",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });
});
