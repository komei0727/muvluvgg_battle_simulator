import { describe, expect, it } from "vitest";
import { DomainValidationError } from "../../domain/shared/errors.js";
import {
  CatalogShapeValidationError,
  mapCapabilityDefinition,
  mapEffectActionDefinition,
  mapMemoryDefinition,
  mapSkillDefinition,
  mapUnitDefinition,
} from "./catalog-definition-mapper.js";

// `14_Catalog定義スキーマ.md` の UnitDefinition YAML 全体像 を JSON 化したもの。
const unitDto = {
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
    criticalDamageBonus: 0.5,
    affinityBonus: 0.25,
    actionSpeed: 780,
    maximumAp: 4,
    maximumPp: 4,
  },
  extraGaugeMaximum: 7,
  activeSkillDefinitionIds: ["SKL_001_AS1", "SKL_001_AS2"],
  passiveSkillDefinitionIds: ["SKL_001_PS1", "SKL_001_PS2"],
  extraSkillDefinitionId: "SKL_001_EX",
  requiredCapabilities: [],
  metadata: {
    displayName: "【純真無垢なるジーニアス】リディア・エルドリッジ",
    characterName: "リディア・エルドリッジ",
    characterId: "CHAR_LYDIA_ELDRIDGE",
    affiliations: [],
    tags: [],
  },
};

// `14_Catalog定義スキーマ.md` の SkillDefinition YAML 全体像 を JSON 化したもの。
const skillDto = {
  skillDefinitionId: "SKL_001_AS1",
  skillType: "AS",
  cost: { resource: "AP", amount: 1 },
  activationCondition: { kind: "TRUE" },
  triggers: [],
  resolution: {
    kind: "IMMEDIATE",
    targetBindings: [
      {
        targetBindingId: "TGT_PRIMARY",
        selector: {
          kind: "SELECT",
          side: "ENEMY",
          count: 1,
          order: ["NEAREST", "FRONT_ROW", "LEFT_TO_RIGHT"],
        },
      },
    ],
    steps: [
      {
        kind: "ACTION",
        target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
        actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
      },
    ],
  },
  cooldown: { unit: "ACTION", count: 1 },
  traits: {
    priorityAttack: false,
    simultaneousActivationLimited: false,
    exclusiveActivationGroupId: null,
    accuracy: { guaranteedHit: false },
    piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
  },
  requiredCapabilities: [],
  metadata: { displayName: "ジャマしちゃ、めっ……だよ？", tags: [] },
};

// `14_Catalog定義スキーマ.md` の EffectActionDefinition YAML 全体像 を JSON 化したもの。
const effectActionDto = {
  effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020",
  kind: "DAMAGE",
  payload: {
    damageType: "PHYSICAL",
    formula: { kind: "SKILL_POWER", power: 0.702 },
    hitCount: 1,
    link: { enabled: false },
  },
  requiredCapabilities: [],
  metadata: { tags: [] },
};

const memoryDto = {
  memoryDefinitionId: "MEM_001",
  triggeredEffects: [
    {
      trigger: {
        eventType: "BattleStarted",
        category: "FACT",
        sourceSelector: "ANY",
        targetSelector: "ANY",
      },
      effectSequence: {
        targetBindings: [
          {
            targetBindingId: "TGT_ALL_ALLIES",
            selector: { kind: "SELECT", side: "ALLY", count: "ALL" },
          },
        ],
        steps: [
          {
            kind: "ACTION",
            target: { kind: "BINDING", targetBindingId: "TGT_ALL_ALLIES" },
            actions: [{ effectActionDefinitionId: "ACT_MEMORY_ATTACK_FIXED_250" }],
          },
        ],
      },
    },
  ],
  modifiers: [],
  requiredCapabilities: [],
  metadata: { displayName: "Colorful Bouquet", tags: [] },
};

const capabilityDto = {
  capabilityId: "CAP_HEAL",
  status: "PLANNED",
  description: "即時回復EffectAction",
  requiredBy: [],
};

describe("Catalog v2 definition mapper", () => {
  it("UT-INFRA-MAP-001: maps the doc's minimal Unit example end-to-end", () => {
    const unit = mapUnitDefinition(unitDto);
    expect(unit.unitDefinitionId).toBe("UNIT_001");
    expect(unit.baseStats.affinityBonus).toBe(0.25);
    expect(Object.isFrozen(unit)).toBe(true);
  });

  it("UT-INFRA-MAP-002: maps the doc's minimal Skill example, resolving its TargetBinding reference", () => {
    const skill = mapSkillDefinition(skillDto);
    expect(skill.skillDefinitionId).toBe("SKL_001_AS1");
    expect(skill.resolution.kind).toBe("IMMEDIATE");
    if (skill.resolution.kind === "IMMEDIATE") {
      expect(skill.resolution.steps[0]).toMatchObject({
        target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
      });
    }
  });

  it("UT-INFRA-MAP-003: maps the doc's minimal EffectActionDefinition example", () => {
    const action = mapEffectActionDefinition(effectActionDto);
    expect(action.effectActionDefinitionId).toBe("ACT_DAMAGE_PHYSICAL_7020");
    expect(action.kind).toBe("DAMAGE");
  });

  it("UT-INFRA-MAP-004: maps the doc's Memory BattleStarted example", () => {
    const memory = mapMemoryDefinition(memoryDto);
    expect(memory.memoryDefinitionId).toBe("MEM_001");
    expect(memory.triggeredEffects).toHaveLength(1);
  });

  it("UT-INFRA-MAP-005: maps a Capability definition", () => {
    const capability = mapCapabilityDefinition(capabilityDto);
    expect(capability.capabilityId).toBe("CAP_HEAL");
  });

  it("UT-INFRA-MAP-006: raises CatalogShapeValidationError for a shape-invalid Unit DTO (JSON Schema stage)", () => {
    expect(() => mapUnitDefinition({ ...unitDto, attribute: "BRAVE" })).toThrow(
      CatalogShapeValidationError,
    );
  });

  it("UT-INFRA-MAP-007: raises DomainValidationError for a shape-valid but semantically-invalid Skill DTO (cost/skillType mismatch)", () => {
    expect(() => mapSkillDefinition({ ...skillDto, cost: { resource: "PP", amount: 1 } })).toThrow(
      DomainValidationError,
    );
  });

  it("UT-INFRA-MAP-008: raises DomainValidationError for a Skill referencing an undeclared targetBindingId", () => {
    const invalidSkill = {
      ...skillDto,
      resolution: {
        kind: "IMMEDIATE",
        targetBindings: [],
        steps: skillDto.resolution.steps,
      },
    };
    expect(() => mapSkillDefinition(invalidSkill)).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-009: produces the same immutable shape from the same input on repeated conversions", () => {
    const first = mapUnitDefinition(unitDto);
    const second = mapUnitDefinition(unitDto);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("UT-INFRA-MAP-010: raises CatalogShapeValidationError for a shape-invalid Skill DTO", () => {
    expect(() => mapSkillDefinition({ ...skillDto, skillType: "NOT_A_TYPE" })).toThrow(
      CatalogShapeValidationError,
    );
  });

  it("UT-INFRA-MAP-011: raises CatalogShapeValidationError for a shape-invalid EffectActionDefinition DTO", () => {
    expect(() => mapEffectActionDefinition({ ...effectActionDto, kind: "APPLY_SHIELD" })).toThrow(
      CatalogShapeValidationError,
    );
  });

  it("UT-INFRA-MAP-012: raises CatalogShapeValidationError for a shape-invalid Memory DTO", () => {
    expect(() => mapMemoryDefinition({ triggeredEffects: [] })).toThrow(
      CatalogShapeValidationError,
    );
  });

  it("UT-INFRA-MAP-013: raises CatalogShapeValidationError for a shape-invalid Capability DTO", () => {
    expect(() => mapCapabilityDefinition({ capabilityId: "CAP_HEAL", status: "DONE" })).toThrow(
      CatalogShapeValidationError,
    );
  });

  it("UT-INFRA-MAP-014: raises DomainValidationError for a shape-valid but semantically-invalid Memory DTO (neither triggeredEffects nor modifiers)", () => {
    expect(() =>
      mapMemoryDefinition({ memoryDefinitionId: "MEM_002", metadata: { displayName: "Empty" } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-015: raises DomainValidationError for a shape-valid but semantically-invalid EffectActionDefinition DTO (missing formula)", () => {
    expect(() =>
      mapEffectActionDefinition({
        effectActionDefinitionId: "ACT_DAMAGE_1",
        kind: "DAMAGE",
        payload: { damageType: "PHYSICAL" },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-016: maps a Capability with a Q-* id", () => {
    const capability = mapCapabilityDefinition({
      capabilityId: "Q-TGT-06",
      status: "BLOCKED",
      description: "pending",
    });
    expect(capability.capabilityId).toBe("Q-TGT-06");
  });
});
