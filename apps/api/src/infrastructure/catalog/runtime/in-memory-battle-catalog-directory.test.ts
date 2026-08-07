import { describe, expect, it } from "vitest";
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

function damageAction(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "DAMAGE",
      payload: { damageType: "PHYSICAL", formula: { kind: "SKILL_POWER", power: 1 } },
    },
    "effectAction",
  );
}

/**
 * M7-006（Issue #179、R-MEM-04）: Memory の `triggeredEffects` は使用者BattleUnitを
 * 持たないため、`DAMAGE`のように発生源ユニットを必要とするEffectActionを参照できない
 * （`MEMORY_REQUIRES_SOURCE_UNIT`）。Memory用のfixtureは静的なstat補正を使う。
 */
function memoryModifierAction(id: string): EffectActionDefinition {
  return createEffectActionDefinition(
    {
      effectActionDefinitionId: id,
      kind: "APPLY_DAMAGE_MOD",
      payload: {
        direction: "INCOMING",
        damageType: null,
        formula: { kind: "CONSTANT", value: 0.1 },
        stacking: { mode: "STACKABLE" },
        duration: { dispellable: true, timeLimit: { unit: "BATTLE", count: 1 } },
      },
    },
    "effectAction",
  );
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
    metadata: { displayName: "EX" },
  });
}

function asSkill(id: string): SkillDefinition {
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
    metadata: { displayName: "AS" },
  });
}

function unit(id: string): UnitDefinition {
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
    metadata: { displayName: "Unit", characterName: "Character", characterId: "CHAR_1" },
  });
}

function buildDefinitions(): CatalogDefinitions {
  return {
    units: [unit("UNIT_001"), unit("UNIT_002")],
    skills: [asSkill("SKL_AS1"), exSkill("SKL_EX1", 7)],
    effectActions: [damageAction("ACT_DAMAGE_AS"), memoryModifierAction("ACT_DAMAGE_MEMORY")],
    memories: [memory("MEM_001")],
  };
}

function memory(id: string): MemoryDefinition {
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
    metadata: { displayName: "Memory" },
  });
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
