import { describe, expect, it } from "vitest";
import { createCapabilityDefinition } from "../capability/capability-definition.js";
import { createEffectActionDefinition } from "./effect-action-definition-factory.js";
import { createUnitDefinition } from "./unit-definition.js";

describe("Converted Definitions are immutable", () => {
  it("UT-CAT-FREEZE-001: a UnitDefinition and its nested objects/arrays are frozen", () => {
    const unit = createUnitDefinition({
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

    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(unit.baseStats)).toBe(true);
    expect(Object.isFrozen(unit.activeSkillDefinitionIds)).toBe(true);
    expect(Object.isFrozen(unit.metadata)).toBe(true);

    expect(() => {
      (unit as { attribute: string }).attribute = "CLEVER";
    }).toThrow(TypeError);
    expect(() => {
      (unit.activeSkillDefinitionIds as unknown as string[]).push("SKL_999");
    }).toThrow(TypeError);
  });

  it("UT-CAT-FREEZE-002: an EffectActionDefinition's nested formula/payload objects are frozen", () => {
    const action = createEffectActionDefinition(
      {
        effectActionDefinitionId: "ACT_DAMAGE_1",
        kind: "DAMAGE",
        payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
        requiredCapabilities: [],
      },
      "effectAction",
    );

    expect(Object.isFrozen(action)).toBe(true);
    expect(Object.isFrozen(action.payload)).toBe(true);
    if (action.kind === "DAMAGE") {
      expect(Object.isFrozen(action.payload.formula)).toBe(true);
    }
    expect(() => {
      (action as { kind: string }).kind = "HEAL";
    }).toThrow(TypeError);
  });

  it("UT-CAT-FREEZE-003: two conversions of the same input produce deep-equal, independently-frozen definitions", () => {
    const input = {
      capabilityId: "CAP_HEAL",
      schemaStatus: "SUPPORTED" as const,
      runtimeStatus: "PLANNED" as const,
      implementationTaskId: "TEST-001",
      description: "即時回復",
      verification: {
        productionDefinitionIds: [] as string[],
        testCaseIds: [] as string[],
      },
    };
    const first = createCapabilityDefinition(input);
    const second = createCapabilityDefinition(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
