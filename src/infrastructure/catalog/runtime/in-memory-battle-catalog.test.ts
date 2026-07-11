import { describe, expect, it } from "vitest";
import {
  createCapabilityDefinition,
  type CapabilityDefinition,
} from "../../../domain/catalog/capability-definition.js";
import {
  buildCatalogIndex,
  type CatalogDefinitions,
} from "../../../domain/catalog/catalog-integrity.js";
import {
  createEffectActionDefinition,
  type EffectActionDefinition,
} from "../../../domain/catalog/effect-action-definition.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../../../domain/catalog/memory-definition.js";
import {
  createSkillDefinition,
  type SkillDefinition,
} from "../../../domain/catalog/skill-definition.js";
import {
  createUnitDefinition,
  type UnitDefinition,
} from "../../../domain/catalog/unit-definition.js";
import { InMemoryBattleCatalog } from "./in-memory-battle-catalog.js";

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

function asSkill(id: string, requiredCapabilities: readonly string[] = []): SkillDefinition {
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
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_AS" }],
        },
      ],
    },
    cooldown: { unit: "ACTION", count: 1 },
    traits: {},
    requiredCapabilities,
    metadata: { displayName: "AS" },
  });
}

function chargeSkill(id: string): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "CHARGE",
      steps: [
        {
          kind: "ACTION",
          target: { kind: "SELF" },
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_CHARGE_START" }],
        },
      ],
      chargeRelease: {
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
            actions: [{ effectActionDefinitionId: "ACT_DAMAGE_CHARGE_RELEASE" }],
          },
        ],
      },
    },
    cooldown: { unit: "ACTION", count: 0 },
    traits: {},
    requiredCapabilities: [],
    metadata: { displayName: "Charge" },
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
          actions: [{ effectActionDefinitionId: "ACT_DAMAGE_AS" }],
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
  overrides: {
    active?: readonly string[];
    requiredCapabilities?: readonly string[];
  } = {},
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

function memory(id: string, requiredCapabilities: readonly string[] = []): MemoryDefinition {
  return createMemoryDefinition({
    memoryDefinitionId: id,
    triggeredEffects: [
      {
        trigger: {
          eventType: "BattleStarted",
          category: "FACT",
          sourceSelector: "SELF",
          targetSelector: "ALLY",
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
              actions: [{ effectActionDefinitionId: "ACT_DAMAGE_MEMORY" }],
            },
          ],
        },
      },
    ],
    requiredCapabilities,
    metadata: { displayName: "Memory" },
  });
}

function capability(id: string, status = "IMPLEMENTED"): CapabilityDefinition {
  return createCapabilityDefinition({ capabilityId: id, status, description: "d", requiredBy: [] });
}

describe("InMemoryBattleCatalog.loadSnapshot", () => {
  it("carries the catalogRevision through to the snapshot", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001")],
      skills: [asSkill("SKL_AS1"), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_AS")],
      memories: [],
      capabilities: [],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    expect(catalog.loadSnapshot([], []).catalogRevision).toBe("rev-1");
  });

  it("includes capabilities required directly by a Unit and transitively by its Skills/EffectActions", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001", { requiredCapabilities: ["CAP_UNIT"] })],
      skills: [asSkill("SKL_AS1", ["CAP_SKILL"]), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_AS", ["CAP_ACTION"])],
      memories: [],
      capabilities: [capability("CAP_UNIT"), capability("CAP_SKILL"), capability("CAP_ACTION")],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    const snapshot = catalog.loadSnapshot(["UNIT_001" as never], []);
    expect(new Set(snapshot.capabilities.keys())).toEqual(
      new Set(["CAP_UNIT", "CAP_SKILL", "CAP_ACTION"]),
    );
  });

  it("includes both the CHARGE step and chargeRelease step EffectActions for a charge Skill", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001", { active: ["SKL_CHARGE"] })],
      skills: [chargeSkill("SKL_CHARGE"), exSkill("SKL_EX1", 7)],
      effectActions: [
        damageAction("ACT_DAMAGE_CHARGE_START"),
        damageAction("ACT_DAMAGE_CHARGE_RELEASE"),
        damageAction("ACT_DAMAGE_AS"),
      ],
      memories: [],
      capabilities: [],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    const snapshot = catalog.loadSnapshot(["UNIT_001" as never], []);
    expect(snapshot.effectActions.has("ACT_DAMAGE_CHARGE_START" as never)).toBe(true);
    expect(snapshot.effectActions.has("ACT_DAMAGE_CHARGE_RELEASE" as never)).toBe(true);
  });

  it("includes a requested Memory, its triggeredEffect EffectActions, and their requiredCapabilities", () => {
    const defs: CatalogDefinitions = {
      units: [],
      skills: [],
      effectActions: [damageAction("ACT_DAMAGE_MEMORY", ["CAP_MEMORY_ACTION"])],
      memories: [memory("MEM_001", ["CAP_MEMORY"])],
      capabilities: [capability("CAP_MEMORY"), capability("CAP_MEMORY_ACTION")],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    const snapshot = catalog.loadSnapshot([], ["MEM_001" as never]);
    expect(snapshot.memories.has("MEM_001" as never)).toBe(true);
    expect(snapshot.effectActions.has("ACT_DAMAGE_MEMORY" as never)).toBe(true);
    expect(new Set(snapshot.capabilities.keys())).toEqual(
      new Set(["CAP_MEMORY", "CAP_MEMORY_ACTION"]),
    );
  });

  it("omits a requested Memory id that does not exist in the Catalog rather than throwing", () => {
    const defs: CatalogDefinitions = {
      units: [],
      skills: [],
      effectActions: [],
      memories: [],
      capabilities: [],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    const snapshot = catalog.loadSnapshot([], ["MEM_MISSING" as never]);
    expect(snapshot.memories.size).toBe(0);
  });

  it("returns Maps with no mutating methods, so a caller cannot write into the snapshot even by casting the type away", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001")],
      skills: [asSkill("SKL_AS1"), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_AS")],
      memories: [],
      capabilities: [],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    const snapshot = catalog.loadSnapshot(["UNIT_001" as never], []);
    const mutableUnits: object = snapshot.units;
    expect("set" in mutableUnits).toBe(false);
    expect("delete" in mutableUnits).toBe(false);
    expect("clear" in mutableUnits).toBe(false);
  });
});
