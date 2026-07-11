import { describe, expect, it } from "vitest";
import { createDurationDefinition } from "./duration-definition.js";
import { DomainValidationError } from "../shared/errors.js";

describe("DurationDefinition", () => {
  it("UT-CAT-DUR-001: maps a timeLimit with default dispellable and linkedEffectGroupId", () => {
    const result = createDurationDefinition(
      { timeLimit: { unit: "ACTION", count: 2 } },
      "duration",
      undefined,
    );
    expect(result).toEqual({
      timeLimit: { unit: "ACTION", count: 2 },
      dispellable: true,
      linkedEffectGroupId: null,
    });
  });

  it("UT-CAT-DUR-002: maps timeLimit.owner when present", () => {
    const result = createDurationDefinition(
      { timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" } },
      "duration",
      undefined,
    );
    expect(result.timeLimit).toEqual({ unit: "ACTION", count: 1, owner: "BATTLE" });
  });

  it("UT-CAT-DUR-003: maps consumption.kind LETHAL_DAMAGE with maxCount", () => {
    const result = createDurationDefinition(
      {
        timeLimit: { unit: "BATTLE", count: 1 },
        consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
      },
      "duration",
      undefined,
    );
    expect(result.consumption).toEqual({ kind: "LETHAL_DAMAGE", maxCount: 1 });
  });

  it("UT-CAT-DUR-004: rejects consumption.maxCount below 1", () => {
    expect(() =>
      createDurationDefinition(
        { consumption: { kind: "LETHAL_DAMAGE", maxCount: 0 } },
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-005: rejects timeLimit.count below 1", () => {
    expect(() =>
      createDurationDefinition({ timeLimit: { unit: "ACTION", count: 0 } }, "duration", undefined),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-006: rejects an unknown consumption kind", () => {
    expect(() =>
      createDurationDefinition(
        { consumption: { kind: "NEXT_MOON", maxCount: 1 } },
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-007: honors an explicit dispellable=false and a linkedEffectGroupId", () => {
    const result = createDurationDefinition(
      { dispellable: false, linkedEffectGroupId: "GROUP_1" },
      "duration",
      undefined,
    );
    expect(result).toEqual({ dispellable: false, linkedEffectGroupId: "GROUP_1" });
  });

  it("UT-CAT-DUR-008: maps expiration.conditions, resolving nested BINDING references against scope", () => {
    const scope = new Set(["TGT_PRIMARY"]);
    const result = createDurationDefinition(
      {
        expiration: {
          conditions: [
            {
              kind: "TARGET_STATE",
              target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
              field: "IS_ALIVE",
              op: "EQ",
              value: false,
            },
          ],
        },
      },
      "duration",
      scope,
    );
    expect(result.expiration).toEqual({
      conditions: [
        {
          kind: "TARGET_STATE",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          field: "IS_ALIVE",
          op: "EQ",
          value: false,
        },
      ],
    });
  });

  it("UT-CAT-DUR-009: rejects a non-boolean dispellable", () => {
    expect(() =>
      createDurationDefinition(
        { dispellable: "nope" as unknown as boolean },
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-010: rejects a linkedEffectGroupId that is neither a string nor null", () => {
    expect(() =>
      createDurationDefinition(
        { linkedEffectGroupId: 123 as unknown as string },
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-011: rejects a non-array expiration.conditions", () => {
    expect(() =>
      createDurationDefinition(
        { expiration: { conditions: "not-an-array" as unknown as never[] } },
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-012: rejects a typo'd sibling key at the top level", () => {
    expect(() =>
      createDurationDefinition(
        { dispellable: true, typoField: "oops" } as never,
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-013: rejects a typo'd sibling key inside timeLimit", () => {
    expect(() =>
      createDurationDefinition(
        { timeLimit: { unit: "ACTION", count: 1, typoField: "oops" } as never },
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-DUR-014: rejects a typo'd sibling key inside consumption", () => {
    expect(() =>
      createDurationDefinition(
        { consumption: { kind: "LETHAL_DAMAGE", maxCount: 1, typoField: "oops" } as never },
        "duration",
        undefined,
      ),
    ).toThrow(DomainValidationError);
  });
});
