import { describe, expect, it } from "vitest";
import { createCapabilityDefinition } from "./capability-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

describe("CapabilityDefinition", () => {
  it("UT-CAT-CAP-001: maps a PLANNED capability", () => {
    const result = createCapabilityDefinition({
      capabilityId: "CAP_HEAL",
      status: "PLANNED",
      description: "即時回復EffectAction",
      requiredBy: [],
    });
    expect(result).toEqual({
      capabilityId: "CAP_HEAL",
      status: "PLANNED",
      description: "即時回復EffectAction",
      requiredBy: [],
    });
  });

  it("UT-CAT-CAP-002: rejects an unknown status", () => {
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        status: "DONE",
        description: "x",
        requiredBy: [],
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-CAP-003: accepts a Q-* capability id", () => {
    const result = createCapabilityDefinition({
      capabilityId: "Q-TGT-06",
      status: "BLOCKED",
      description: "pending spec",
      requiredBy: [],
    });
    expect(result.capabilityId).toBe("Q-TGT-06");
  });

  it("UT-CAT-CAP-004: rejects a non-array requiredBy", () => {
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        status: "PLANNED",
        description: "x",
        requiredBy: "SKL_001_AS1" as unknown as readonly string[],
      }),
    ).toThrow(DomainValidationError);
  });
});
