import { describe, expect, it } from "vitest";
import { createTriggerDefinition } from "./trigger-definition.js";
import { DomainValidationError } from "../shared/errors.js";

describe("TriggerDefinition", () => {
  it("UT-CAT-TRIG-001: maps a trigger with a default TRUE condition", () => {
    const result = createTriggerDefinition(
      { eventType: "TurnStarted", category: "FACT", sourceSelector: "ANY", targetSelector: "ANY" },
      "trigger",
    );
    expect(result).toEqual({
      eventType: "TurnStarted",
      category: "FACT",
      sourceSelector: "ANY",
      targetSelector: "ANY",
      condition: { kind: "TRUE" },
    });
  });

  it("UT-CAT-TRIG-002: maps an explicit condition", () => {
    const result = createTriggerDefinition(
      {
        eventType: "DamageApplied",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ALLY",
        condition: { kind: "EVENT_PAYLOAD", field: "hpDamage", op: "GT", value: 0 },
      },
      "trigger",
    );
    expect(result.condition).toEqual({
      kind: "EVENT_PAYLOAD",
      field: "hpDamage",
      op: "GT",
      value: 0,
    });
  });

  it("UT-CAT-TRIG-003: rejects an empty eventType", () => {
    expect(() =>
      createTriggerDefinition(
        { eventType: "", category: "FACT", sourceSelector: "ANY", targetSelector: "ANY" },
        "trigger",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TRIG-004: rejects category DIAGNOSTIC for a trigger", () => {
    expect(() =>
      createTriggerDefinition(
        {
          eventType: "TurnStarted",
          category: "DIAGNOSTIC",
          sourceSelector: "ANY",
          targetSelector: "ANY",
        },
        "trigger",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TRIG-005: rejects an unknown sourceSelector", () => {
    expect(() =>
      createTriggerDefinition(
        {
          eventType: "TurnStarted",
          category: "FACT",
          sourceSelector: "SOURCE_SIDE",
          targetSelector: "ANY",
        },
        "trigger",
      ),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-TRIG-006: rejects a typo'd sibling key", () => {
    expect(() =>
      createTriggerDefinition(
        {
          eventType: "TurnStarted",
          category: "FACT",
          sourceSelector: "ANY",
          targetSelector: "ANY",
          typoField: "oops",
        } as never,
        "trigger",
      ),
    ).toThrow(DomainValidationError);
  });
});
