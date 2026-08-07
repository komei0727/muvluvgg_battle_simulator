import { describe, expect, it } from "vitest";
import { runPreflight } from "./simulation-preflight-validator.js";
import type { SimulateBattleCommand } from "./simulate-battle-command.js";
import { ApplicationError } from "../contracts/application-error.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import {
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
  type MemoryDefinitionId,
  type UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import {} from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";

function unitDefinition(id: string): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    attribute: "AGGRESSIVE",
    unitType: "PHYSICAL",
    role: "PHYSICAL_ATTACKER",
    positionAptitudes: ["FRONT", "BACK"],
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
    metadata: { displayName: id, characterName: id, characterId: id, affiliations: [], tags: [] },
  };
}

function snapshot(overrides: Partial<BattleCatalogSnapshot> = {}): BattleCatalogSnapshot {
  return {
    catalogRevision: "rev-1",
    units: new Map<UnitDefinitionId, UnitDefinition>([
      [createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")],
    ]),
    skills: new Map(),
    effectActions: new Map(),
    memories: new Map<MemoryDefinitionId, MemoryDefinition>(),
    ...overrides,
  };
}

function command(overrides: Partial<SimulateBattleCommand> = {}): SimulateBattleCommand {
  return {
    allyFormation: {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: 0, row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId("UNIT_001"),
          position: { column: 0, row: "FRONT" },
        },
      ],
      memoryDefinitionIds: [],
    },
    turnLimit: 30,
    logLevel: "DETAILED",
    ...overrides,
  };
}

describe("runPreflight", () => {
  it("UT-PREFLIGHT-001: passes when every referenced Unit exists and requires no Capability", () => {
    expect(() => runPreflight(command(), snapshot())).not.toThrow();
  });

  it("UT-PREFLIGHT-002 (R-FRM-06): rejects with DEFINITION_NOT_FOUND when a Unit reference is unknown", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_MISSING"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });

    try {
      runPreflight(cmd, snapshot());
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.slots[0].unitDefinitionId" }),
      );
    }
  });

  it("UT-PREFLIGHT-003: collects every unknown Unit/Memory reference across both formations in one error", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_MISSING_A"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [createMemoryDefinitionId("MEM_MISSING")],
      },
      enemyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_MISSING_B"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [],
      },
    });

    try {
      runPreflight(cmd, snapshot());
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      const violations = (error as ApplicationError).violations;
      expect(violations).toHaveLength(3);
    }
  });

  it("UT-PREFLIGHT-006: rejects with DEFINITION_NOT_FOUND when a Memory reference is unknown", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
          },
        ],
        memoryDefinitionIds: [createMemoryDefinitionId("MEM_MISSING")],
      },
    });

    try {
      runPreflight(cmd, snapshot());
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.memoryDefinitionIds[0]" }),
      );
    }
  });
});
