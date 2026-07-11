import { describe, expect, it } from "vitest";
import {
  createCapabilityId,
  createEffectActionDefinitionId,
  createMarkerId,
  createMemoryDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
  createTargetBindingId,
  createUnitDefinitionId,
} from "./catalog-ids.js";
import { DomainValidationError } from "../shared/errors.js";

describe("Catalog branded IDs", () => {
  it("UT-CAT-ID-001: accepts a well-formed UnitDefinitionId", () => {
    expect(createUnitDefinitionId("UNIT_001")).toBe("UNIT_001");
  });

  it("UT-CAT-ID-002: rejects a UnitDefinitionId missing the UNIT_ prefix", () => {
    expect(() => createUnitDefinitionId("SKL_001")).toThrow(DomainValidationError);
  });

  it("UT-CAT-ID-003: rejects an ID containing characters outside the allowed charset", () => {
    expect(() => createUnitDefinitionId("UNIT_あ01")).toThrow(DomainValidationError);
  });

  it("UT-CAT-ID-004: accepts well-formed IDs for every prefixed ID kind", () => {
    expect(createSkillDefinitionId("SKL_001_AS1")).toBe("SKL_001_AS1");
    expect(createEffectActionDefinitionId("ACT_DAMAGE_PHYSICAL_7020")).toBe(
      "ACT_DAMAGE_PHYSICAL_7020",
    );
    expect(createMemoryDefinitionId("MEM_001")).toBe("MEM_001");
    expect(createTargetBindingId("TGT_PRIMARY")).toBe("TGT_PRIMARY");
    expect(createMarkerId("MARKER_CURSE")).toBe("MARKER_CURSE");
  });

  it("UT-CAT-ID-005: accepts CapabilityId with either CAP_ or Q- prefix", () => {
    expect(createCapabilityId("CAP_HEAL")).toBe("CAP_HEAL");
    expect(createCapabilityId("Q-TGT-06")).toBe("Q-TGT-06");
  });

  it("UT-CAT-ID-006: rejects a CapabilityId without an allowed prefix", () => {
    expect(() => createCapabilityId("HEAL")).toThrow(DomainValidationError);
  });

  it("UT-CAT-ID-007: accepts a RuntimeCounterId with no fixed prefix", () => {
    expect(createRuntimeCounterId("ps-reactivation-scope-1")).toBe("ps-reactivation-scope-1");
  });

  it("UT-CAT-ID-008: rejects an empty ID", () => {
    expect(() => createUnitDefinitionId("")).toThrow(DomainValidationError);
  });
});
