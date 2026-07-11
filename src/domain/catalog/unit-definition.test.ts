import { describe, expect, it } from "vitest";
import { createUnitDefinition } from "./unit-definition.js";
import { DomainValidationError } from "../shared/errors.js";

function minimalUnitInput() {
  return {
    unitDefinitionId: "UNIT_001",
    attribute: "COMICAL",
    unitType: "AGILE",
    role: "CONTROL",
    positionAptitudes: ["FRONT", "BACK"],
    baseStats: {
      maximumHp: 28375,
      attack: 23221,
      defense: 11781,
      criticalRate: 0.25,
      actionSpeed: 780,
      maximumAp: 4,
      maximumPp: 4,
    },
    extraGaugeMaximum: 7,
    activeSkillDefinitionIds: ["SKL_001_AS1", "SKL_001_AS2"],
    passiveSkillDefinitionIds: ["SKL_001_PS1"],
    extraSkillDefinitionId: "SKL_001_EX",
    metadata: {
      displayName: "【純真無垢なるジーニアス】リディア・エルドリッジ",
      characterName: "リディア・エルドリッジ",
      characterId: "CHAR_LYDIA_ELDRIDGE",
    },
  };
}

describe("UnitDefinition", () => {
  it("UT-CAT-UNIT-001: maps a minimal Unit, generating default affinityBonus and criticalDamageBonus", () => {
    const result = createUnitDefinition(minimalUnitInput());
    expect(result.baseStats.affinityBonus).toBe(0.25);
    expect(result.baseStats.criticalDamageBonus).toBe(0.5);
    expect(result.unitDefinitionId).toBe("UNIT_001");
    expect(result.activeSkillDefinitionIds).toEqual(["SKL_001_AS1", "SKL_001_AS2"]);
    expect(result.metadata.affiliations).toEqual([]);
    expect(result.metadata.tags).toEqual([]);
  });

  it("UT-CAT-UNIT-002: honors an explicit affinityBonus/criticalDamageBonus override", () => {
    const input = minimalUnitInput();
    const result = createUnitDefinition({
      ...input,
      baseStats: { ...input.baseStats, affinityBonus: 0.3, criticalDamageBonus: 0.6 },
    });
    expect(result.baseStats.affinityBonus).toBe(0.3);
    expect(result.baseStats.criticalDamageBonus).toBe(0.6);
  });

  it("UT-CAT-UNIT-003: rejects maximumHp below 1", () => {
    const input = minimalUnitInput();
    expect(() =>
      createUnitDefinition({ ...input, baseStats: { ...input.baseStats, maximumHp: 0 } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-UNIT-004: rejects maximumAp below 1", () => {
    const input = minimalUnitInput();
    expect(() =>
      createUnitDefinition({ ...input, baseStats: { ...input.baseStats, maximumAp: 0 } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-CAT-UNIT-005: rejects an empty positionAptitudes array", () => {
    expect(() => createUnitDefinition({ ...minimalUnitInput(), positionAptitudes: [] })).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-UNIT-006: rejects extraGaugeMaximum below 1", () => {
    expect(() => createUnitDefinition({ ...minimalUnitInput(), extraGaugeMaximum: 0 })).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-UNIT-007: rejects an unknown attribute", () => {
    expect(() => createUnitDefinition({ ...minimalUnitInput(), attribute: "BRAVE" })).toThrow(
      DomainValidationError,
    );
  });

  it("UT-CAT-UNIT-008: rejects a malformed extraSkillDefinitionId", () => {
    expect(() =>
      createUnitDefinition({ ...minimalUnitInput(), extraSkillDefinitionId: "NOT_A_SKILL" }),
    ).toThrow(DomainValidationError);
  });
});
