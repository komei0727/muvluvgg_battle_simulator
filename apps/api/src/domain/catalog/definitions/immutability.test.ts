import { describe, expect, it } from "vitest";
import { createEffectActionDefinition } from "./effect-action-definition-factory.js";
import { createUnitDefinition } from "./unit-definition.js";

/**
 * 意図的な横断テスト（`12_テスト戦略.md`の co-location 規約における `<module>.test.ts`
 * 命名の例外）。凍結は個々の定義ファクトリではなく変換結果全体に課される不変条件のため、
 * `<module>.test.ts` へ分散させると「どのファクトリが未凍結か」を全件で守れなくなる。
 */

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
      effectActionDefinitionId: "ACT_DAMAGE_1",
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
    };
    const first = createEffectActionDefinition(input, "effectAction");
    const second = createEffectActionDefinition(input, "effectAction");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
