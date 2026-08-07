import { describe, expect, it } from "vitest";
import {
  buildCatalogIndex,
  type CatalogDefinitions,
} from "../../../domain/catalog/integrity/catalog-integrity.js";
import type { EffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition.js";
import { createEffectActionDefinition } from "../../../domain/catalog/definitions/effect-action-definition-factory.js";
import {} from "../../../domain/catalog/definitions/memory-definition.js";
import {
  createSkillDefinition,
  type SkillDefinition,
} from "../../../domain/catalog/definitions/skill-definition.js";
import {
  createUnitDefinition,
  type UnitDefinition,
} from "../../../domain/catalog/definitions/unit-definition.js";
import { InMemoryBattleCatalog } from "./in-memory-battle-catalog.js";

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

function chargeSkill(id: string): SkillDefinition {
  return createSkillDefinition({
    skillDefinitionId: id,
    skillType: "AS",
    cost: { resource: "AP", amount: 1 },
    resolution: {
      kind: "CHARGE",
      // M7-016（Issue #270）: CHARGE開始側は`resolveChargeStart`が
      // 一つも解決しないため`steps`は常に空。EffectActionは`chargeRelease`だけが持つ。
      steps: [],
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
    // M7-016（Issue #270）: `resolution.kind: CHARGE`は`CAP_CHARGE_RESTRICTION`の
    // 宣言が必須（`catalog-integrity.ts`の`validateSkill`）。
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
    metadata: { displayName: "Unit", characterName: "Character", characterId: "CHAR_1" },
  });
}

describe("InMemoryBattleCatalog.loadSnapshot", () => {
  it("carries the catalogRevision through to the snapshot", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001")],
      skills: [asSkill("SKL_AS1"), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_AS")],
      memories: [],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    expect(catalog.loadSnapshot([], []).catalogRevision).toBe("rev-1");
  });

  it("includes the chargeRelease step EffectActions for a charge Skill (M7-016, Issue #270: the CHARGE start side carries no steps, so chargeRelease is the only source)", () => {
    const defs: CatalogDefinitions = {
      units: [unit("UNIT_001", { active: ["SKL_CHARGE"] })],
      skills: [chargeSkill("SKL_CHARGE"), exSkill("SKL_EX1", 7)],
      effectActions: [damageAction("ACT_DAMAGE_CHARGE_RELEASE"), damageAction("ACT_DAMAGE_AS")],
      memories: [],
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    const snapshot = catalog.loadSnapshot(["UNIT_001" as never], []);
    expect(snapshot.effectActions.has("ACT_DAMAGE_CHARGE_RELEASE" as never)).toBe(true);
  });

  it("omits a requested Memory id that does not exist in the Catalog rather than throwing", () => {
    const defs: CatalogDefinitions = {
      units: [],
      skills: [],
      effectActions: [],
      memories: [],
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
    };
    const catalog = new InMemoryBattleCatalog("rev-1", buildCatalogIndex(defs));
    const snapshot = catalog.loadSnapshot(["UNIT_001" as never], []);
    const mutableUnits: object = snapshot.units;
    expect("set" in mutableUnits).toBe(false);
    expect("delete" in mutableUnits).toBe(false);
    expect("clear" in mutableUnits).toBe(false);
  });
});
