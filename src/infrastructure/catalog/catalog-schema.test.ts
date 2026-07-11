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
      metadata: { displayName: "Test", characterName: "Test", characterId: "CHAR_TEST" },
    });
    expect(valid).toBe(true);
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
      metadata: { displayName: "Test", characterName: "Test", characterId: "CHAR_TEST" },
    });
    expect(valid).toBe(false);
  });

  it("UT-INFRA-SCHEMA-005: accepts an EffectActionDefinition DTO regardless of payload internals (shape-only)", () => {
    const valid = validateEffectActionDefinitionDto({
      effectActionDefinitionId: "ACT_DAMAGE_1",
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
    });
    expect(valid).toBe(true);
  });

  it("UT-INFRA-SCHEMA-006: rejects an EffectActionDefinition DTO with an unsupported kind", () => {
    const valid = validateEffectActionDefinitionDto({
      effectActionDefinitionId: "ACT_SHIELD_1",
      kind: "APPLY_SHIELD",
      payload: {},
    });
    expect(valid).toBe(false);
  });
});
