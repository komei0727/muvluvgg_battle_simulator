import { Ajv, type ValidateFunction } from "ajv";

/**
 * Catalog v2 DTO JSON Schema — the "Shape" stage of the load pipeline
 * (`11_インフラストラクチャ設計.md`: Read → Hash → Shape → Resolve → Semantic
 * → Freeze). It validates top-level required fields, ID patterns, and the
 * closed enums documented in `14_Catalog定義スキーマ.md`.
 *
 * Recursive/polymorphic sub-trees (`ConditionDefinition`, `FormulaDefinition`,
 * `EffectStepDefinition`, `TargetSelectorDefinition`, per-kind
 * `EffectActionDefinition` payloads — anything built from `looseObject` /
 * `looseObjectArray` below) are accepted here as generic objects and
 * validated precisely by `catalog-definition-mapper.ts`, which is backed by
 * the Domain factories in `src/domain/catalog`. Splitting the two avoids two
 * independent, drift-prone copies of the same deeply nested contract. These
 * regions do NOT reject unknown properties at the Shape stage.
 *
 * Every other object — the top level of each DTO and every fixed-shape sub-
 * object (`baseStats`, `metadata`, `cost`, `cooldown`, the outer `resolution`
 * envelope) — sets `additionalProperties: false` per `12_テスト戦略.md`'s
 * Catalogテスト方針 ("未知プロパティを拒否する"). Without this, a typo like
 * `requiredCapability` (singular) sitting next to a correct but empty
 * `requiredCapabilities: []` would pass Shape validation silently, and the
 * downstream Capability preflight would never see the intended requirement.
 */

const idSchema = (prefix: string) => ({
  type: "string",
  pattern: `^${prefix}[A-Za-z0-9_-]*$`,
});

const looseObject = { type: "object" } as const;
const looseObjectArray = { type: "array", items: looseObject } as const;

export const unitDefinitionSchema = {
  $id: "https://muvluvgg.local/catalog/unit-definition.json",
  type: "object",
  additionalProperties: false,
  required: [
    "unitDefinitionId",
    "attribute",
    "unitType",
    "role",
    "positionAptitudes",
    "baseStats",
    "extraGaugeMaximum",
    "activeSkillDefinitionIds",
    "passiveSkillDefinitionIds",
    "extraSkillDefinitionId",
    "requiredCapabilities",
    "metadata",
  ],
  properties: {
    unitDefinitionId: idSchema("UNIT_"),
    attribute: { enum: ["AGGRESSIVE", "SHY", "CUTE", "SMART", "COMICAL", "CLEVER"] },
    unitType: { enum: ["PHYSICAL", "ENERGY", "AGILE"] },
    role: { enum: ["PHYSICAL_ATTACKER", "EN_ATTACKER", "TANK", "SUPPORT", "CONTROL"] },
    positionAptitudes: {
      type: "array",
      minItems: 1,
      items: { enum: ["FRONT", "BACK"] },
    },
    baseStats: {
      type: "object",
      additionalProperties: false,
      required: [
        "maximumHp",
        "attack",
        "defense",
        "criticalRate",
        "actionSpeed",
        "maximumAp",
        "maximumPp",
      ],
      properties: {
        maximumHp: { type: "integer", minimum: 1 },
        attack: { type: "integer", minimum: 0 },
        defense: { type: "integer", minimum: 0 },
        criticalRate: { type: "number" },
        criticalDamageBonus: { type: "number" },
        affinityBonus: { type: "number" },
        actionSpeed: { type: "integer", minimum: 0 },
        maximumAp: { type: "integer", minimum: 1 },
        maximumPp: { type: "integer", minimum: 1 },
      },
    },
    extraGaugeMaximum: { type: "integer", minimum: 1 },
    activeSkillDefinitionIds: { type: "array", items: idSchema("SKL_") },
    passiveSkillDefinitionIds: { type: "array", items: idSchema("SKL_") },
    extraSkillDefinitionId: idSchema("SKL_"),
    requiredCapabilities: { type: "array", items: { type: "string" } },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["displayName", "characterName", "characterId"],
      properties: {
        displayName: { type: "string" },
        characterName: { type: "string" },
        characterId: { type: "string" },
        affiliations: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export const skillDefinitionSchema = {
  $id: "https://muvluvgg.local/catalog/skill-definition.json",
  type: "object",
  additionalProperties: false,
  required: [
    "skillDefinitionId",
    "skillType",
    "cost",
    "resolution",
    "cooldown",
    "traits",
    "requiredCapabilities",
    "metadata",
  ],
  properties: {
    skillDefinitionId: idSchema("SKL_"),
    skillType: { enum: ["AS", "PS", "EX"] },
    cost: {
      type: "object",
      additionalProperties: false,
      required: ["resource", "amount"],
      properties: {
        resource: { enum: ["AP", "PP", "EX_GAUGE"] },
        amount: { type: "integer", minimum: 0 },
      },
    },
    activationCondition: looseObject,
    triggers: looseObjectArray,
    resolution: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "steps"],
      properties: {
        kind: { enum: ["IMMEDIATE", "CHARGE"] },
        targetBindings: looseObjectArray,
        steps: { type: "array", minItems: 1, items: looseObject },
        chargeRelease: looseObject,
      },
    },
    cooldown: {
      type: "object",
      additionalProperties: false,
      required: ["unit", "count"],
      properties: {
        unit: { enum: ["ACTION", "TURN"] },
        count: { type: "integer", minimum: 0 },
      },
    },
    traits: looseObject,
    requiredCapabilities: { type: "array", items: { type: "string" } },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["displayName"],
      properties: {
        displayName: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export const effectActionDefinitionSchema = {
  $id: "https://muvluvgg.local/catalog/effect-action-definition.json",
  type: "object",
  additionalProperties: false,
  required: ["effectActionDefinitionId", "kind", "payload", "requiredCapabilities"],
  properties: {
    effectActionDefinitionId: idSchema("ACT_"),
    kind: {
      enum: [
        "DAMAGE",
        "HEAL",
        "APPLY_CONTINUOUS_HEAL",
        "APPLY_CONTINUOUS_DAMAGE",
        "APPLY_STAT_MOD",
        "APPLY_DAMAGE_MOD",
        "APPLY_HEALING_MOD",
        "MODIFY_RESOURCE",
        "MODIFY_RESOURCE_CAPACITY",
        "APPLY_STATUS",
        "APPLY_SHIELD",
        "REMOVE_EFFECTS",
        "EFFECT_IMMUNITY",
        "APPLY_MARKER",
        "REMOVE_MARKER",
        "APPLY_DEATH_SURVIVAL",
        "APPLY_TARGET_REDIRECT",
        "APPLY_COVER",
        "APPLY_REFLECT",
        "APPLY_SUBUNIT",
      ],
    },
    payload: looseObject,
    requiredCapabilities: { type: "array", items: { type: "string" } },
    metadata: {
      type: "object",
      additionalProperties: false,
      properties: { tags: { type: "array", items: { type: "string" } } },
    },
  },
} as const;

export const memoryDefinitionSchema = {
  $id: "https://muvluvgg.local/catalog/memory-definition.json",
  type: "object",
  additionalProperties: false,
  required: ["memoryDefinitionId", "requiredCapabilities", "metadata"],
  properties: {
    memoryDefinitionId: idSchema("MEM_"),
    triggeredEffects: looseObjectArray,
    requiredCapabilities: { type: "array", items: { type: "string" } },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["displayName"],
      properties: {
        displayName: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export const capabilityDefinitionSchema = {
  $id: "https://muvluvgg.local/catalog/capability-definition.json",
  type: "object",
  additionalProperties: false,
  required: ["capabilityId", "status", "description", "requiredBy"],
  properties: {
    capabilityId: { type: "string", pattern: "^(CAP_|Q-)[A-Za-z0-9_-]*$" },
    status: { enum: ["IMPLEMENTED", "PLANNED", "BLOCKED"] },
    description: { type: "string" },
    requiredBy: { type: "array", items: { type: "string" } },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });

function compile(schema: object): ValidateFunction {
  return ajv.compile(schema);
}

export const validateUnitDefinitionDto = compile(unitDefinitionSchema);
export const validateSkillDefinitionDto = compile(skillDefinitionSchema);
export const validateEffectActionDefinitionDto = compile(effectActionDefinitionSchema);
export const validateMemoryDefinitionDto = compile(memoryDefinitionSchema);
export const validateCapabilityDefinitionDto = compile(capabilityDefinitionSchema);
