import { describe, expect, it } from "vitest";
import { createCapabilityDefinition, type CapabilityDefinition } from "./capability-definition.js";
import { buildCatalogIndex, type CatalogDefinitions } from "./catalog-integrity.js";
import {
  collectRequiredCapabilities,
  findUnimplementedCapabilities,
} from "./capability-availability.js";
import {
  createEffectActionDefinition,
  type EffectActionDefinition,
} from "./effect-action-definition.js";
import { createMemoryDefinition, type MemoryDefinition } from "./memory-definition.js";
import { createSkillDefinition, type SkillDefinition } from "./skill-definition.js";
import { createUnitDefinition, type UnitDefinition } from "./unit-definition.js";

function damageAction(
  id: string,
  requiredCapabilities: readonly string[] = [],
): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
      requiredCapabilities,
    },
    "effectAction",
  );
}

function asSkill(
  id: string,
  targetActionId: string,
  requiredCapabilities: readonly string[] = [],
): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: targetActionId }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "AS" },
  });
}

function exSkill(id: string, amount: number): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "EX",
    cost: { resource: "EX_GAUGE", amount },
    resolution: {
      kind: "IMMEDIATE",
      targetBindings: [
        {
          targetBindingId: "TGT_PRIMARY",
          selector: { kind: "SELECT", side: "ENEMY", count: 1, order: ["DEFAULT"] },
        },
      ],
      steps: [
        {
          kind: "ACTION",
          target: { kind: "BINDING", targetBindingId: "TGT_PRIMARY" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_1" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities: [],
    metadata: { displayName: "EX" },
  });
}

function unit(
  id: string,
  overrides: { active?: readonly string[]; requiredCapabilities?: readonly string[] } = {},
): UnitDefinition {
  return createUnitDefinition({
    unitDefinitionId: id,
    attribute: "COMICAL",
    unitType: "AGILE",
    role: "CONTROL",
    positionAptitudes: ["FRONT"],
    baseStats: {
      maximumHp: 1000,
      attack: 100,
      defense: 50,
      criticalRate: 0.1,
      actionSpeed: 100,
      maximumAp: 4,
      maximumPp: 4,
    },
    extraGaugeMaximum: 7,
    activeSkillDefinitionIds: overrides.active ?? ["SKL_AS1"],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: "SKL_EX1",
    requiredCapabilities: overrides.requiredCapabilities ?? [],
    metadata: { displayName: "Unit", characterName: "Character", characterId: "CHAR_1" },
  });
}

function memoryWithCapability(
  id: string,
  requiredCapabilities: readonly string[],
): MemoryDefinition {
  return createMemoryDefinition({
    memoryDefinitionId: id,
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
              actions: [{ effectActionDefinitionId: "ACT_ATTACK_UP" }],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Memory" },
  });
}

function capability(id: string, status: string): CapabilityDefinition {
  return createCapabilityDefinition({ capabilityId: id, status, description: "d", requiredBy: [] });
}

describe("collectRequiredCapabilities / findUnimplementedCapabilities", () => {
  it("UT-CAT-CAP-001: collects capabilities declared directly on a selected Unit", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001", { requiredCapabilities: ["CAP_HEAL"] })],
      skills: [asSkill("SKL_AS1", "ACT_DAMAGE_1"), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_1")],
      memories: [],
      capabilities: [capability("CAP_HEAL", "PLANNED")],
    };
    const index = buildCatalogIndex(defs);
    const required = collectRequiredCapabilities(index, ["UNIT_001" as never], []);
    expect([...required]).toEqual(["CAP_HEAL"]);
  });

  it("UT-CAT-CAP-002: collects capabilities transitively through Skill and EffectAction references", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001")],
      skills: [
        asSkill("SKL_AS1", "ACT_DAMAGE_1", ["CAP_RESOLUTION_BRANCH"]),
        exSkill("SKL_EX1", 7),
      ],
      effectActions: [damageAction("ACT_DAMAGE_1", ["CAP_PARTIAL_PIERCING"])],
      memories: [],
      capabilities: [
        capability("CAP_RESOLUTION_BRANCH", "IMPLEMENTED"),
        capability("CAP_PARTIAL_PIERCING", "PLANNED"),
      ],
    };
    const index = buildCatalogIndex(defs);
    const required = collectRequiredCapabilities(index, ["UNIT_001" as never], []);
    expect(new Set(required)).toEqual(new Set(["CAP_RESOLUTION_BRANCH", "CAP_PARTIAL_PIERCING"]));
  });

  it("UT-CAT-CAP-003: collects capabilities from selected Memories", () => {
    const defs: CatalogDefinitions = {
      units: [],
      skills: [],
      effectActions: [damageAction("ACT_ATTACK_UP")],
      memories: [memoryWithCapability("MEM_001", ["CAP_MEMORY_DYNAMIC_EFFECT"])],
      capabilities: [capability("CAP_MEMORY_DYNAMIC_EFFECT", "IMPLEMENTED")],
    };
    const index = buildCatalogIndex(defs);
    const required = collectRequiredCapabilities(index, [], ["MEM_001" as never]);
    expect([...required]).toEqual(["CAP_MEMORY_DYNAMIC_EFFECT"]);
  });

  it("UT-CAT-CAP-004: findUnimplementedCapabilities returns only non-IMPLEMENTED capabilities", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001", { requiredCapabilities: ["CAP_A", "CAP_B", "CAP_C"] })],
      skills: [asSkill("SKL_AS1", "ACT_DAMAGE_1"), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_1")],
      memories: [],
      capabilities: [
        capability("CAP_A", "IMPLEMENTED"),
        capability("CAP_B", "PLANNED"),
        capability("CAP_C", "BLOCKED"),
      ],
    };
    const index = buildCatalogIndex(defs);
    const required = collectRequiredCapabilities(index, ["UNIT_001" as never], []);
    const unimplemented = findUnimplementedCapabilities(required, index.capabilities);
    expect(new Set(unimplemented)).toEqual(new Set(["CAP_B", "CAP_C"]));
  });

  it("UT-CAT-CAP-005: a decided Q-* capability marked IMPLEMENTED is not treated as unsupported", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001", { requiredCapabilities: ["Q-BTL-05"] })],
      skills: [asSkill("SKL_AS1", "ACT_DAMAGE_1"), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_1")],
      memories: [],
      capabilities: [capability("Q-BTL-05", "IMPLEMENTED")],
    };
    const index = buildCatalogIndex(defs);
    const required = collectRequiredCapabilities(index, ["UNIT_001" as never], []);
    expect(findUnimplementedCapabilities(required, index.capabilities)).toEqual([]);
  });

  it("UT-CAT-CAP-006: only collects capabilities for the selected Unit, not the whole Catalog", () => {
    const defs: CatalogDefinitions = {
      units: [
        unit("UNIT_001", { requiredCapabilities: ["CAP_HEAL"] }),
        unit("UNIT_002", { active: ["SKL_AS2"], requiredCapabilities: ["CAP_MARKER"] }),
      ],
      skills: [
        asSkill("SKL_AS1", "ACT_DAMAGE_1"),
        asSkill("SKL_AS2", "ACT_DAMAGE_1"),
        exSkill("SKL_EX1", 7),
      ],
      effectActions: [damageAction("ACT_DAMAGE_1")],
      memories: [],
      capabilities: [capability("CAP_HEAL", "PLANNED"), capability("CAP_MARKER", "PLANNED")],
    };
    const index = buildCatalogIndex(defs);
    const required = collectRequiredCapabilities(index, ["UNIT_001" as never], []);
    expect([...required]).toEqual(["CAP_HEAL"]);
  });
});
