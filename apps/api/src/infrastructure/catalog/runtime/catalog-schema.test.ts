import { describe, expect, it } from "vitest";
import {
  validateCapabilityDefinitionDto,
  validateEffectActionDefinitionDto,
  validateSkillDefinitionDto,
  validateUnitDefinitionDto,
} from "./catalog-schema.js";

describe("Catalog v2 DTO JSON Schema", () => {
  it("UT-INFRA-SCHEMA-001: accepts a structurally valid UnitDefinition DTO", () => {
    const valid = validateUnitDefinitionDto({
      unitDefinitionId: "UNIT_001",
      attribute: "COMICAL",
      unitType: "AGILE",
      role: "CONTROL",
      positionAptitudes: ["FRONT"],
      baseStats: {
        maximumHp: 100,
        attack: 10,
        defense: 10,
        criticalRate: 0.1,
        actionSpeed: 100,
        maximumAp: 4,
        maximumPp: 4,
      },
      extraGaugeMaximum: 5,
      activeSkillDefinitionIds: ["SKL_001_AS1"],
      passiveSkillDefinitionIds: [],
      extraSkillDefinitionId: "SKL_001_EX",
      requiredCapabilities: [],
      metadata: { displayName: "Test", characterName: "Test", characterId: "CHAR_TEST" },
    });
    expect(valid).toBe(true);
  });

  it("UT-INFRA-SCHEMA-001b: rejects a UnitDefinition DTO missing requiredCapabilities", () => {
    const valid = validateUnitDefinitionDto({
      unitDefinitionId: "UNIT_001",
      attribute: "COMICAL",
      unitType: "AGILE",
      role: "CONTROL",
      positionAptitudes: ["FRONT"],
      baseStats: {
        maximumHp: 100,
        attack: 10,
        defense: 10,
        criticalRate: 0.1,
        actionSpeed: 100,
        maximumAp: 4,
        maximumPp: 4,
      },
      extraGaugeMaximum: 5,
      activeSkillDefinitionIds: ["SKL_001_AS1"],
      passiveSkillDefinitionIds: [],
      extraSkillDefinitionId: "SKL_001_EX",
      metadata: { displayName: "Test", characterName: "Test", characterId: "CHAR_TEST" },
    });
    expect(valid).toBe(false);
  });

  it("UT-INFRA-SCHEMA-002: rejects a UnitDefinition DTO with an unknown attribute", () => {
    const valid = validateUnitDefinitionDto({
      unitDefinitionId: "UNIT_001",
      attribute: "BRAVE",
      unitType: "AGILE",
      role: "CONTROL",
      positionAptitudes: ["FRONT"],
      baseStats: {
        maximumHp: 100,
        attack: 10,
        defense: 10,
        criticalRate: 0.1,
        actionSpeed: 100,
        maximumAp: 4,
        maximumPp: 4,
      },
      extraGaugeMaximum: 5,
      activeSkillDefinitionIds: [],
      passiveSkillDefinitionIds: [],
      extraSkillDefinitionId: "SKL_001_EX",
      requiredCapabilities: [],
      metadata: { displayName: "Test", characterName: "Test", characterId: "CHAR_TEST" },
    });
    expect(valid).toBe(false);
    expect(validateUnitDefinitionDto.errors?.length).toBeGreaterThan(0);
  });

  it("UT-INFRA-SCHEMA-003: rejects a DTO missing required fields", () => {
    expect(validateUnitDefinitionDto({})).toBe(false);
    expect(validateSkillDefinitionDto({})).toBe(false);
    expect(validateEffectActionDefinitionDto({})).toBe(false);
    expect(validateCapabilityDefinitionDto({})).toBe(false);
  });

  it("UT-INFRA-SCHEMA-004: rejects a malformed ID that violates the pattern", () => {
    const valid = validateUnitDefinitionDto({
      unitDefinitionId: "not-prefixed",
      attribute: "COMICAL",
      unitType: "AGILE",
      role: "CONTROL",
      positionAptitudes: ["FRONT"],
      baseStats: {
        maximumHp: 100,
        attack: 10,
        defense: 10,
        criticalRate: 0.1,
        actionSpeed: 100,
        maximumAp: 4,
        maximumPp: 4,
      },
      extraGaugeMaximum: 5,
      activeSkillDefinitionIds: [],
      passiveSkillDefinitionIds: [],
      extraSkillDefinitionId: "SKL_001_EX",
      requiredCapabilities: [],
      metadata: { displayName: "Test", characterName: "Test", characterId: "CHAR_TEST" },
    });
    expect(valid).toBe(false);
  });

  it("UT-INFRA-SCHEMA-005: accepts an EffectActionDefinition DTO regardless of payload internals (shape-only)", () => {
    const valid = validateEffectActionDefinitionDto({
      effectActionDefinitionId: "ACT_DAMAGE_1",
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
      requiredCapabilities: [],
    });
    expect(valid).toBe(true);
  });

  it("UT-INFRA-SCHEMA-006: rejects an EffectActionDefinition DTO with an unsupported kind", () => {
    const valid = validateEffectActionDefinitionDto({
      effectActionDefinitionId: "ACT_LINK_1",
      kind: "APPLY_DAMAGE_LINK",
      payload: {},
      requiredCapabilities: [],
    });
    expect(valid).toBe(false);
  });

  it("UT-INFRA-SCHEMA-007: rejects DTOs missing required Capability metadata across all artifact types", () => {
    expect(
      validateSkillDefinitionDto({
        skillDefinitionId: "SKL_001_AS1",
        skillType: "AS",
        cost: { resource: "AP", amount: 1 },
        resolution: { kind: "IMMEDIATE", steps: [{ kind: "ACTION" }] },
        cooldown: { unit: "ACTION", count: 1 },
        traits: {},
        metadata: { displayName: "x" },
      }),
    ).toBe(false);
    expect(
      validateEffectActionDefinitionDto({
        effectActionDefinitionId: "ACT_DAMAGE_1",
        kind: "DAMAGE",
        payload: {},
      }),
    ).toBe(false);
    expect(
      validateCapabilityDefinitionDto({
        capabilityId: "CAP_HEAL",
        schemaStatus: "SUPPORTED",
        runtimeStatus: "PLANNED",
        implementationTaskId: "TEST-001",
        description: "x",
      }),
    ).toBe(false);
  });

  it("UT-INFRA-SCHEMA-008: rejects an EffectActionDefinition DTO with a typo'd sibling of requiredCapabilities (additionalProperties: false)", () => {
    const valid = validateEffectActionDefinitionDto({
      effectActionDefinitionId: "ACT_HEAL_1",
      kind: "HEAL",
      payload: { formula: { kind: "CONSTANT", value: 1 } },
      requiredCapabilities: [],
      // Typo: singular "requiredCapability" instead of "requiredCapabilities".
      // additionalProperties:false must reject this rather than silently
      // ignoring the intended Capability requirement.
      requiredCapability: ["CAP_HEAL"],
    });
    expect(valid).toBe(false);
    expect(
      validateEffectActionDefinitionDto.errors?.some((e) => e.keyword === "additionalProperties"),
    ).toBe(true);
  });

  it("UT-INFRA-SCHEMA-009: rejects a SkillDefinition DTO with a typo'd sibling of requiredCapabilities", () => {
    const valid = validateSkillDefinitionDto({
      skillDefinitionId: "SKL_001_AS1",
      skillType: "AS",
      cost: { resource: "AP", amount: 1 },
      resolution: { kind: "IMMEDIATE", steps: [{ kind: "ACTION" }] },
      cooldown: { unit: "ACTION", count: 1 },
      traits: {},
      requiredCapabilities: [],
      requiredCapability: ["CAP_HEAL"],
      metadata: { displayName: "x" },
    });
    expect(valid).toBe(false);
  });

  it("UT-INFRA-SCHEMA-011 (R-ACT-03: コストは1以上): rejects a SkillDefinition DTO with cost.amount 0", () => {
    const valid = validateSkillDefinitionDto({
      skillDefinitionId: "SKL_001_AS1",
      skillType: "AS",
      cost: { resource: "AP", amount: 0 },
      resolution: { kind: "IMMEDIATE", steps: [{ kind: "ACTION" }] },
      cooldown: { unit: "ACTION", count: 1 },
      traits: {},
      requiredCapabilities: [],
      metadata: { displayName: "x" },
    });
    expect(valid).toBe(false);
  });

  it("UT-INFRA-SCHEMA-010: rejects an unknown property inside a fixed-shape sub-object (baseStats)", () => {
    const valid = validateUnitDefinitionDto({
      unitDefinitionId: "UNIT_001",
      attribute: "COMICAL",
      unitType: "AGILE",
      role: "CONTROL",
      positionAptitudes: ["FRONT"],
      baseStats: {
        maximumHp: 100,
        attack: 10,
        defense: 10,
        criticalRate: 0.1,
        actionSpeed: 100,
        maximumAp: 4,
        maximumPp: 4,
        maximunHp: 100,
      },
      extraGaugeMaximum: 5,
      activeSkillDefinitionIds: [],
      passiveSkillDefinitionIds: [],
      extraSkillDefinitionId: "SKL_001_EX",
      requiredCapabilities: [],
      metadata: { displayName: "Test", characterName: "Test", characterId: "CHAR_TEST" },
    });
    expect(valid).toBe(false);
  });
});
