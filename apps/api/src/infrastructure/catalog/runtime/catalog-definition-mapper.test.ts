import { describe, expect, it } from "vitest";
import { DomainValidationError } from "../../../domain/shared/errors.js";
import {
  CatalogShapeValidationError,
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
  metadata: { displayName: "Colorful Bouquet", tags: [] },
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

  // Issue #519（R-STA-03）: `kindKey`はShape段階（JSON Schema）でも通す必要がある
  // — `effectActionDefinitionSchema`は`additionalProperties: false`のため、
  // 追加し忘れるとMapperがDomain factoryへ届く前に拒否してしまう。
  it("UT-INFRA-MAP-031: maps an EffectActionDefinition DTO declaring a kindKey", () => {
    const action = mapEffectActionDefinition({
      ...effectActionDto,
      kindKey: "KIND_DAMAGE_PHYSICAL",
    });
    expect(action.kindKey).toBe("KIND_DAMAGE_PHYSICAL");
  });

  it("UT-INFRA-MAP-032: raises CatalogShapeValidationError for a kindKey missing the KIND_ prefix", () => {
    expect(() =>
      mapEffectActionDefinition({ ...effectActionDto, kindKey: "ACT_DAMAGE_PHYSICAL_7020" }),
    ).toThrow(CatalogShapeValidationError);
  });

  it("UT-INFRA-MAP-011: raises CatalogShapeValidationError for a shape-invalid EffectActionDefinition DTO", () => {
    expect(() =>
      mapEffectActionDefinition({ ...effectActionDto, kind: "APPLY_TIME_STOP" }),
    ).toThrow(CatalogShapeValidationError);
  });

  it("UT-INFRA-MAP-012: raises CatalogShapeValidationError for a shape-invalid Memory DTO", () => {
    expect(() => mapMemoryDefinition({ triggeredEffects: [] })).toThrow(
      CatalogShapeValidationError,
    );
  });

  it("UT-INFRA-MAP-014: raises DomainValidationError for a shape-valid but semantically-invalid Memory DTO (empty triggeredEffects)", () => {
    expect(() =>
      mapMemoryDefinition({
        memoryDefinitionId: "MEM_002",
        triggeredEffects: [],
        metadata: { displayName: "Empty" },
      }),
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

  it("UT-INFRA-MAP-018: raises DomainValidationError when a Skill's traits booleans are wrong-typed (bypasses the loose JSON Schema, caught by the Mapper)", () => {
    expect(() =>
      mapSkillDefinition({ ...skillDto, traits: { ...skillDto.traits, priorityAttack: "false" } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-019: raises DomainValidationError when an EffectActionDefinition's duration.dispellable is wrong-typed", () => {
    expect(() =>
      mapEffectActionDefinition({
        effectActionDefinitionId: "ACT_IMMUNITY_1",
        kind: "EFFECT_IMMUNITY",
        payload: {
          categories: ["DEBUFF"],
          duration: { timeLimit: { unit: "ACTION", count: 1 }, dispellable: "nope" },
          maxBlocks: null,
        },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-020: raises CatalogShapeValidationError when a typo'd sibling of requiredCapabilities sits alongside the correct (empty) field", () => {
    // A typo like `requiredCapability` (singular) must not silently coexist
    // with a correct-but-empty `requiredCapabilities: []` — otherwise the
    // author's intended Capability requirement is lost, and the downstream
    // Capability preflight checks an empty array instead.
    expect(() =>
      mapEffectActionDefinition({
        ...effectActionDto,
        requiredCapability: ["CAP_REFLECT_DAMAGE"],
      }),
    ).toThrow(CatalogShapeValidationError);
  });

  it("UT-INFRA-MAP-021: raises CatalogShapeValidationError when a typo'd sibling of requiredCapabilities sits on a Skill DTO", () => {
    expect(() => mapSkillDefinition({ ...skillDto, requiredCapability: ["CAP_HEAL"] })).toThrow(
      CatalogShapeValidationError,
    );
  });

  it("UT-INFRA-MAP-022: raises DomainValidationError (not silent success) for a typo inside EffectActionDefinition.payload, which the loose JSON Schema does not catch", () => {
    // `payload` is deliberately a generic object in the JSON Schema (Shape
    // stage); the Mapper's Domain factories are the layer responsible for
    // rejecting an unknown key like `typoDamageFiled` sitting next to the
    // correctly-spelled `formula`.
    expect(() =>
      mapEffectActionDefinition({
        ...effectActionDto,
        payload: { ...effectActionDto.payload, typoDamageFiled: "oops" },
      }),
    ).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-023: raises DomainValidationError for a typo inside Skill.traits, which the loose JSON Schema does not catch", () => {
    expect(() =>
      mapSkillDefinition({ ...skillDto, traits: { ...skillDto.traits, typoTraitField: true } }),
    ).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-024: raises DomainValidationError for a typo inside a resolution step, which the loose JSON Schema does not catch", () => {
    const invalidSkill = {
      ...skillDto,
      resolution: {
        ...skillDto.resolution,
        steps: [{ ...skillDto.resolution.steps[0], typoStepField: "oops" }],
      },
    };
    expect(() => mapSkillDefinition(invalidSkill)).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-025: raises DomainValidationError for a stale targetBindingId on a non-BINDING TargetReference inside a step's target", () => {
    const invalidSkill = {
      ...skillDto,
      resolution: {
        ...skillDto.resolution,
        steps: [
          {
            kind: "ACTION",
            target: { kind: "SELF", targetBindingId: "TGT_UNUSED" },
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE_PHYSICAL_7020" }],
          },
        ],
      },
    };
    expect(() => mapSkillDefinition(invalidSkill)).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-026: raises DomainValidationError for a stale count on a non-SELECT targetBinding selector", () => {
    const invalidSkill = {
      ...skillDto,
      resolution: {
        ...skillDto.resolution,
        targetBindings: [{ targetBindingId: "TGT_PRIMARY", selector: { kind: "SELF", count: 1 } }],
      },
    };
    expect(() => mapSkillDefinition(invalidSkill)).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-027: raises DomainValidationError for a stale base on a SELECT targetBinding selector", () => {
    const invalidSkill = {
      ...skillDto,
      resolution: {
        ...skillDto.resolution,
        targetBindings: [
          {
            targetBindingId: "TGT_PRIMARY",
            selector: { kind: "SELECT", side: "ENEMY", count: 1, base: { kind: "SELF" } },
          },
        ],
      },
    };
    expect(() => mapSkillDefinition(invalidSkill)).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-028: raises DomainValidationError for a WEIGHTED_ONE RandomBranch that also sets probability", () => {
    const invalidSkill = {
      ...skillDto,
      resolution: {
        kind: "IMMEDIATE",
        steps: [
          {
            kind: "RANDOM_BRANCH",
            mode: "WEIGHTED_ONE",
            branches: [{ weight: 1, probability: 0.5, steps: [] }],
          },
        ],
      },
    };
    expect(() => mapSkillDefinition(invalidSkill)).toThrow(DomainValidationError);
  });

  it("UT-INFRA-MAP-029: raises CatalogShapeValidationError for a Memory DTO missing the triggeredEffects key entirely", () => {
    expect(() =>
      mapMemoryDefinition({
        memoryDefinitionId: "MEM_002",
        metadata: { displayName: "Empty" },
      }),
    ).toThrow(CatalogShapeValidationError);
  });

  it("UT-INFRA-MAP-030: carries levelGrowth through both stages, and leaves it undefined when the DTO omits it (R-ENH-05)", () => {
    const growth = { hp: 255, attack: 209, defense: 106, actionSpeed: 2 };
    expect(mapUnitDefinition({ ...unitDto, levelGrowth: growth }).levelGrowth).toEqual(growth);
    expect(mapUnitDefinition(unitDto).levelGrowth).toBeUndefined();
  });
});
