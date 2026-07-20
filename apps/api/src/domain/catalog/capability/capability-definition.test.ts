import { describe, expect, it } from "vitest";
import { createCapabilityDefinition } from "./capability-definition.js";
import { DomainValidationError } from "../../shared/errors.js";

describe("CapabilityDefinition", () => {
  it("UT-CAT-CAP-001: maps a PLANNED capability", () => {
    const result = createCapabilityDefinition({
      capabilityId: "CAP_HEAL",
      schemaStatus: "SUPPORTED",
      runtimeStatus: "PLANNED",
      implementationTaskId: "TEST-001",
      description: "即時回復EffectAction",
      verification: { productionDefinitionIds: [], testCaseIds: [] },
    });
    expect(result).toEqual({
      capabilityId: "CAP_HEAL",
      schemaStatus: "SUPPORTED",
      runtimeStatus: "PLANNED",
      implementationTaskId: "TEST-001",
      description: "即時回復EffectAction",
      verification: { productionDefinitionIds: [], testCaseIds: [] },
    });
  });

  it("UT-CAT-CAP-002: rejects an unknown status", () => {
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "DONE",
        implementationTaskId: "TEST-001",
        description: "x",
        verification: { productionDefinitionIds: [], testCaseIds: [] },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-CAP-003: accepts a Q-* capability id", () => {
    const result = createCapabilityDefinition({
      capabilityId: "Q-TGT-06",
      schemaStatus: "SUPPORTED",
      runtimeStatus: "BLOCKED",
      implementationTaskId: "TEST-001",
      description: "pending spec",
      verification: { productionDefinitionIds: [], testCaseIds: [] },
    });
    expect(result.capabilityId).toBe("Q-TGT-06");
  });

  it("UT-CAT-CAP-004: rejects malformed verification evidence", () => {
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "PLANNED",
        implementationTaskId: "TEST-001",
        description: "x",
        verification: {
          productionDefinitionIds: "SKL_001_AS1" as unknown as readonly string[],
          testCaseIds: [],
        },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-CAP-005: requires production and test evidence before IMPLEMENTED", () => {
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "IMPLEMENTED",
        implementationTaskId: "TEST-001",
        description: "x",
        verification: { productionDefinitionIds: [], testCaseIds: [] },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-CAP-006: rejects empty task and verification identifiers", () => {
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "IMPLEMENTED",
        implementationTaskId: " ",
        description: "x",
        verification: { productionDefinitionIds: ["ACT_HEAL"], testCaseIds: [" "] },
      }),
    ).toThrow(DomainValidationError);
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "IMPLEMENTED",
        implementationTaskId: "TEST-001",
        description: "x",
        verification: { productionDefinitionIds: ["ACT_HEAL"], testCaseIds: [" "] },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-CAP-007: rejects duplicate verification identifiers", () => {
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "IMPLEMENTED",
        implementationTaskId: "TEST-001",
        description: "x",
        verification: {
          productionDefinitionIds: ["ACT_HEAL", "ACT_HEAL"],
          testCaseIds: ["IT-HEAL-001"],
        },
      }),
    ).toThrow(/duplicate value/);
    expect(() =>
      createCapabilityDefinition({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "IMPLEMENTED",
        implementationTaskId: "TEST-001",
        description: "x",
        verification: {
          productionDefinitionIds: ["ACT_HEAL"],
          testCaseIds: ["IT-HEAL-001", "IT-HEAL-001"],
        },
      }),
    ).toThrow(/duplicate value/);
  });
});
