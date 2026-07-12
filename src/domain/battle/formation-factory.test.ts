import { describe, expect, it } from "vitest";
import { createBattleParty } from "./formation-factory.js";
import type { FormationInput } from "./formation-input.js";
import {
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type MemoryDefinitionId,
  type UnitDefinitionId,
} from "../catalog/catalog-ids.js";
import { createMemoryDefinition, type MemoryDefinition } from "../catalog/memory-definition.js";
import type { UnitDefinition } from "../catalog/unit-definition.js";
import { createBattleUnitId } from "../shared/ids.js";
import { DomainValidationError } from "../shared/errors.js";
import type { Attribute, PositionRow } from "../catalog/catalog-enums.js";

function unitDefinition(
  id: string,
  attribute: Attribute,
  positionAptitudes: readonly PositionRow[] = ["FRONT", "BACK"],
): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute,
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes,
    baseStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
      actionSpeed: 10,
      maximumAp: 3,
      maximumPp: 3,
    },
    extraGaugeMaximum: 100,
    activeSkillDefinitionIds: [],
    passiveSkillDefinitionIds: [],
    extraSkillDefinitionId: createSkillDefinitionId("SKL_EX"),
    requiredCapabilities: [],
    metadata: {
      displayName: id,
      characterName: id,
      characterId: id,
      affiliations: [],
      tags: [],
    },
  };
}

function unitsMap(...defs: UnitDefinition[]): ReadonlyMap<UnitDefinitionId, UnitDefinition> {
  return new Map(defs.map((d) => [d.unitDefinitionId, d]));
}

function memoriesMap(
  ...defs: MemoryDefinition[]
): ReadonlyMap<MemoryDefinitionId, MemoryDefinition> {
  return new Map(defs.map((d) => [d.memoryDefinitionId, d]));
}

const NO_MEMORIES = memoriesMap();

describe("createBattleParty — FormationFactory", () => {
  it("UT-R-FRM-FACTORY-001: builds a BattleParty with resolved global coordinates and formation bonus", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.side).toBe("ALLY");
    expect(party.members).toHaveLength(1);
    expect(party.members[0]).toEqual({
      battleUnitId: createBattleUnitId("BU_1"),
      unitDefinitionId: createUnitDefinitionId("UNIT_001"),
      position: { column: "LEFT", row: "FRONT" },
      globalCoordinate: { x: 0, y: 2 },
      combatStats: {
        maximumHp: 100,
        attack: 10,
        defense: 10,
        criticalRate: 0.1,
        actionSpeed: 10,
        criticalDamageBonus: 0.5,
      },
    });
    expect(party.memoryDefinitionIds).toEqual([]);
    expect(party.formationBonus.attackBonus).toBeCloseTo(0);
  });

  it("UT-R-FRM-FACTORY-002: assigns distinct BattleUnitIds to slots sharing the same UnitDefinitionId (R-FRM-03)", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "CENTER", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1"), createBattleUnitId("BU_2")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.members.map((m) => m.battleUnitId)).toEqual([
      createBattleUnitId("BU_1"),
      createBattleUnitId("BU_2"),
    ]);
  });

  it("UT-R-FRM-FACTORY-003: computes the formation bonus from the resolved attributes of every member", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_002"),
          position: { column: "CENTER", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_003"),
          position: { column: "RIGHT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_004"),
          position: { column: "LEFT", row: "BACK" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_005"),
          position: { column: "CENTER", row: "BACK" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = ["BU_1", "BU_2", "BU_3", "BU_4", "BU_5"].map((id) =>
      createBattleUnitId(id),
    );
    const units = unitsMap(
      unitDefinition("UNIT_001", "AGGRESSIVE"),
      unitDefinition("UNIT_002", "AGGRESSIVE"),
      unitDefinition("UNIT_003", "AGGRESSIVE"),
      unitDefinition("UNIT_004", "AGGRESSIVE"),
      unitDefinition("UNIT_005", "AGGRESSIVE"),
    );

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.formationBonus.attackBonus).toBeCloseTo(0.25);
    expect(party.formationBonus.hpBonus).toBeCloseTo(0.25);
    expect(party.members[0]!.combatStats.attack).toBeCloseTo(12.5);
    expect(party.members[0]!.combatStats.maximumHp).toBeCloseTo(125);
  });

  it("UT-R-FRM-FACTORY-004: rejects a slot referencing an unknown UnitDefinitionId", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_UNKNOWN"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-FACTORY-005: rejects when the battleUnitIds count does not match the slot count", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "CENTER", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-FACTORY-007: rejects duplicate BattleUnitIds across slots (R-FRM-03)", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "CENTER", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1"), createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });

  it("UT-R-FRM-FACTORY-006: resolves ENEMY-side coordinates using the ENEMY row mapping", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ENEMY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.side).toBe("ENEMY");
    expect(party.members[0]!.globalCoordinate).toEqual({ x: 0, y: 1 });
  });

  it("UT-R-STA-01-018: a mismatched position row applies the aptitude penalty to the member's combat stats", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "BACK" },
        },
      ],
      memoryDefinitionIds: [],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE", ["FRONT"]));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES);

    expect(party.members[0]!.combatStats.maximumHp).toBeCloseTo(95);
    expect(party.members[0]!.combatStats.attack).toBeCloseTo(9.5);
    expect(party.members[0]!.combatStats.defense).toBeCloseTo(9.5);
    expect(party.members[0]!.combatStats.criticalRate).toBeCloseTo(0.1);
  });

  it("UT-R-STA-01-019: a Memory RATIO modifier applies to every member's starting combat stats", () => {
    const memory = createMemoryDefinition({
      memoryDefinitionId: "MEM_001",
      modifiers: [
        { targetFilter: { kind: "ALL" }, stat: "ATTACK", valueType: "RATIO", value: 0.2 },
      ],
      requiredCapabilities: [],
      metadata: { displayName: "Test Memory" },
    });
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    const party = createBattleParty("ALLY", formation, battleUnitIds, units, memoriesMap(memory));

    expect(party.members[0]!.combatStats.attack).toBeCloseTo(12);
  });

  it("UT-R-FRM-FACTORY-008: rejects a formation referencing an unknown MemoryDefinitionId", () => {
    const formation: FormationInput = {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: "LEFT", row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [createMemoryDefinitionId("MEM_MISSING")],
    };
    const battleUnitIds = [createBattleUnitId("BU_1")];
    const units = unitsMap(unitDefinition("UNIT_001", "AGGRESSIVE"));

    expect(() => createBattleParty("ALLY", formation, battleUnitIds, units, NO_MEMORIES)).toThrow(
      DomainValidationError,
    );
  });
});
