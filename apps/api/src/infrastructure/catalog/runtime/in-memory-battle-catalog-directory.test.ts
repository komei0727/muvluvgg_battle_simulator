import { describe, expect, it } from "vitest";
import {
  createCapabilityDefinition,
  type CapabilityDefinition,
} from "../../../domain/catalog/capability/capability-definition.js";
import {
  buildCatalogIndex,
  type CatalogDefinitions,
} from "../../../domain/catalog/integrity/catalog-integrity.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import { createEffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition-factory.js";
import {
  createMemoryDefinition,
  type MemoryDefinition,
} from "../../../domain/catalog/definitions/memory-definition.js";
import {
  createSkillDefinition,
  type SkillDefinition,
} from "../../../domain/catalog/definitions/skill-definition.js";
import {
  createUnitDefinition,
  type UnitDefinition,
} from "../../../domain/catalog/definitions/unit-definition.js";
import { InMemoryBattleCatalogDirectory } from "./in-memory-battle-catalog-directory.js";

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
  overrides: { requiredCapabilities?: readonly string[] } = {},
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
    activeSkillDefinitionIds: ["SKL_AS1"],
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
  const evidenceDefinitionIds: Readonly<Record<string, string>> = {
    CAP_UNIT: "UNIT_001",
    CAP_SKILL: "SKL_AS1",
    CAP_ACTION: "ACT_DAMAGE_AS",
    CAP_MEMORY: "MEM_001",
    CAP_MEMORY_TRIGGERED_EFFECT: "MEM_001",
  };
  const evidenceDefinitionId = evidenceDefinitionIds[id];
  return createCapabilityDefinition({
    capabilityId: id,
    schemaStatus: "SUPPORTED",
    runtimeStatus: status,
    implementationTaskId: "TEST-001",
    description: "d",
    verification: {
      productionDefinitionIds: evidenceDefinitionId === undefined ? [] : [evidenceDefinitionId],
      testCaseIds: status === "IMPLEMENTED" ? ["TEST-001"] : [],
    },
  });
}

function buildDefinitions(): CatalogDefinitions {
  return {
    units: [unit("UNIT_001", { requiredCapabilities: ["CAP_UNIT"] }), unit("UNIT_002")],
    skills: [asSkill("SKL_AS1", ["CAP_SKILL"]), exSkill("SKL_EX1", 7)],
    effectActions: [
      damageAction("ACT_DAMAGE_AS", ["CAP_ACTION"]),
      damageAction("ACT_DAMAGE_MEMORY"),
    ],
    memories: [memory("MEM_001", ["CAP_MEMORY", "CAP_MEMORY_TRIGGERED_EFFECT"])],
    capabilities: [
      capability("CAP_UNIT"),
      capability("CAP_SKILL"),
      capability("CAP_ACTION"),
      capability("CAP_MEMORY"),
      capability("CAP_MEMORY_TRIGGERED_EFFECT"),
    ],
  };
}

describe("InMemoryBattleCatalogDirectory.loadSnapshot", () => {
  it("carries the catalogRevision through to the snapshot", () => {
    const directory = new InMemoryBattleCatalogDirectory(
      "rev-1",
      buildCatalogIndex(buildDefinitions()),
    );
    expect(directory.loadSnapshot().catalogRevision).toBe("rev-1");
  });

  it("returns every Unit and Memory in the Catalog, not just a requested subset", () => {
    const directory = new InMemoryBattleCatalogDirectory(
      "rev-1",
      buildCatalogIndex(buildDefinitions()),
    );
    const snapshot = directory.loadSnapshot();
    expect(new Set(snapshot.units.keys())).toEqual(new Set(["UNIT_001", "UNIT_002"]));
    expect(new Set(snapshot.memories.keys())).toEqual(new Set(["MEM_001"]));
  });

  it("includes every Skill, EffectAction, and Capability needed to compute selectability", () => {
    const directory = new InMemoryBattleCatalogDirectory(
      "rev-1",
      buildCatalogIndex(buildDefinitions()),
    );
    const snapshot = directory.loadSnapshot();
    expect(new Set(snapshot.skills.keys())).toEqual(new Set(["SKL_AS1", "SKL_EX1"]));
    expect(new Set(snapshot.effectActions.keys())).toEqual(
      new Set(["ACT_DAMAGE_AS", "ACT_DAMAGE_MEMORY"]),
    );
    expect(new Set(snapshot.capabilities.keys())).toEqual(
      new Set(["CAP_UNIT", "CAP_SKILL", "CAP_ACTION", "CAP_MEMORY", "CAP_MEMORY_TRIGGERED_EFFECT"]),
    );
  });

  it("returns the same snapshot contents on repeated calls without re-reading the Catalog source", () => {
    const directory = new InMemoryBattleCatalogDirectory(
      "rev-1",
      buildCatalogIndex(buildDefinitions()),
    );
    const first = directory.loadSnapshot();
    const second = directory.loadSnapshot();
    expect(second.catalogRevision).toBe(first.catalogRevision);
    expect(new Set(second.units.keys())).toEqual(new Set(first.units.keys()));
  });

  it("returns Maps with no mutating methods, so a caller cannot write into the snapshot even by casting the type away", () => {
    const directory = new InMemoryBattleCatalogDirectory(
      "rev-1",
      buildCatalogIndex(buildDefinitions()),
    );
    const snapshot = directory.loadSnapshot();
    const mutableUnits: object = snapshot.units;
    expect("set" in mutableUnits).toBe(false);
    expect("delete" in mutableUnits).toBe(false);
    expect("clear" in mutableUnits).toBe(false);
  });
});
