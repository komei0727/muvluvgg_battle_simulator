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

function unitDefinition(
  id: string,
  overrides: Pick<Partial<UnitDefinition>, "category" | "exerciseActive"> = {},
): UnitDefinition {
  return {
    unitDefinitionId: createUnitDefinitionId(id),
    category: overrides.category ?? "PLAYABLE",
    ...(overrides.exerciseActive === undefined ? {} : { exerciseActive: overrides.exerciseActive }),
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
    expect(() => runPreflight(command(), snapshot(), "NORMAL")).not.toThrow();
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
      runPreflight(cmd, snapshot(), "NORMAL");
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
      runPreflight(cmd, snapshot(), "NORMAL");
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
      runPreflight(cmd, snapshot(), "NORMAL");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.memoryDefinitionIds[0]" }),
      );
    }
  });

  it("UT-PREFLIGHT-007 [R-ENH-05] (R-ENH-05 #5): rejects with INVALID_COMMAND when a Unit without levelGrowth is given a level other than 200", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
            enhancement: { level: 220 },
          },
        ],
        memoryDefinitionIds: [],
        enhancement: {},
      },
    });

    try {
      runPreflight(cmd, snapshot(), "NORMAL");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.slots[0].enhancement.level" }),
      );
    }
  });

  it("UT-PREFLIGHT-008 [R-ENH-05] (R-ENH-05 #5): level 200 and an omitted level never consult levelGrowth", () => {
    const withDefaultLevel = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
            enhancement: { level: 200, gears: [{ stat: "ATTACK", tier: "II", grade: "D" }] },
          },
        ],
        memoryDefinitionIds: [],
        enhancement: {},
      },
    });

    expect(() => runPreflight(withDefaultLevel, snapshot(), "NORMAL")).not.toThrow();
  });

  it("UT-PREFLIGHT-009 [R-ENH-05] (R-ENH-05 #2): a Unit that declares levelGrowth accepts any level", () => {
    const growingUnit: UnitDefinition = {
      ...unitDefinition("UNIT_001"),
      levelGrowth: { hp: 255, attack: 209, defense: 106, actionSpeed: 2 },
    };
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
            enhancement: { level: 1 },
          },
        ],
        memoryDefinitionIds: [],
        enhancement: {},
      },
    });

    expect(() =>
      runPreflight(
        cmd,
        snapshot({
          units: new Map<UnitDefinitionId, UnitDefinition>([
            [createUnitDefinitionId("UNIT_001"), growingUnit],
          ]),
        }),
        "NORMAL",
      ),
    ).not.toThrow();
  });

  it("UT-PREFLIGHT-011 [R-ENH-07] (R-ENH-07 #5): rejects with INVALID_COMMAND when a Unit without rankGrowth is given a rank other than 5", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
            enhancement: { rank: 0 },
          },
        ],
        memoryDefinitionIds: [],
        enhancement: {},
      },
    });

    try {
      runPreflight(cmd, snapshot(), "NORMAL");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.slots[0].enhancement.rank" }),
      );
    }
  });

  it("UT-PREFLIGHT-012 [R-ENH-07] (R-ENH-07 #5): rank 5 and an omitted rank never consult rankGrowth", () => {
    const withDefaultRank = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
            enhancement: { rank: 5, gears: [{ stat: "ATTACK", tier: "II", grade: "D" }] },
          },
        ],
        memoryDefinitionIds: [],
        enhancement: {},
      },
    });

    expect(() => runPreflight(withDefaultRank, snapshot(), "NORMAL")).not.toThrow();
  });

  it("UT-PREFLIGHT-013 [R-ENH-07] (R-ENH-07 #2): a Unit that declares rankGrowth accepts every rank from 0 to 5", () => {
    const growingUnit: UnitDefinition = {
      ...unitDefinition("UNIT_001"),
      rankGrowth: { hp: 1200, attack: 900, defense: 500, criticalRate: 0.01 },
    };
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_001"),
            position: { column: 0, row: "FRONT" },
            enhancement: { rank: 0 },
          },
        ],
        memoryDefinitionIds: [],
        enhancement: {},
      },
    });

    expect(() =>
      runPreflight(
        cmd,
        snapshot({
          units: new Map<UnitDefinitionId, UnitDefinition>([
            [createUnitDefinitionId("UNIT_001"), growingUnit],
          ]),
        }),
        "NORMAL",
      ),
    ).not.toThrow();
  });

  it("UT-PREFLIGHT-010: an unknown Unit reference still wins over the levelGrowth check, since the growth check needs a resolved definition", () => {
    const cmd = command({
      allyFormation: {
        slots: [
          {
            unitDefinitionId: createUnitDefinitionId("UNIT_MISSING"),
            position: { column: 0, row: "FRONT" },
            enhancement: { level: 220 },
          },
        ],
        memoryDefinitionIds: [],
        enhancement: {},
      },
    });

    try {
      runPreflight(cmd, snapshot(), "NORMAL");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
    }
  });

  /** UNIT_001=PLAYABLE と UNIT_TEX=EXERCISE_ENEMY（開催状態は引数で指定）の2体入りsnapshot。 */
  function categorySnapshot(exerciseActive = true): BattleCatalogSnapshot {
    return snapshot({
      units: new Map<UnitDefinitionId, UnitDefinition>([
        [createUnitDefinitionId("UNIT_001"), unitDefinition("UNIT_001")],
        [
          createUnitDefinitionId("UNIT_TEX"),
          unitDefinition("UNIT_TEX", { category: "EXERCISE_ENEMY", exerciseActive }),
        ],
      ]),
    });
  }

  function formationOf(unitId: string) {
    return {
      slots: [
        {
          unitDefinitionId: createUnitDefinitionId(unitId),
          position: { column: 0 as const, row: "FRONT" as const },
        },
      ],
      memoryDefinitionIds: [],
    };
  }

  it("UT-R-TEX-11-001: NORMAL rejects an EXERCISE_ENEMY unit in the ally formation with INVALID_COMMAND and the rule id", () => {
    const cmd = command({ allyFormation: formationOf("UNIT_TEX") });

    try {
      runPreflight(cmd, categorySnapshot(), "NORMAL");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({
          path: "allyFormation.slots[0].unitDefinitionId",
          definitionId: "UNIT_TEX",
          ruleId: "R-TEX-11",
        }),
      );
    }
  });

  it("UT-R-TEX-11-002: NORMAL rejects an EXERCISE_ENEMY unit in the enemy formation", () => {
    const cmd = command({ enemyFormation: formationOf("UNIT_TEX") });

    try {
      runPreflight(cmd, categorySnapshot(), "NORMAL");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({
          path: "enemyFormation.slots[0].unitDefinitionId",
          ruleId: "R-TEX-11",
        }),
      );
    }
  });

  it("UT-R-TEX-11-003: TACTICAL_EXERCISE rejects a PLAYABLE unit in the enemy formation", () => {
    const cmd = command({ enemyFormation: formationOf("UNIT_001") });

    try {
      runPreflight(cmd, categorySnapshot(), "TACTICAL_EXERCISE");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      expect((error as ApplicationError).violations).toContainEqual(
        expect.objectContaining({
          path: "enemyFormation.slots[0].unitDefinitionId",
          ruleId: "R-TEX-11",
        }),
      );
    }
  });

  it("UT-R-TEX-11-004: TACTICAL_EXERCISE rejects an EXERCISE_ENEMY unit in the ally formation", () => {
    const cmd = command({
      allyFormation: formationOf("UNIT_TEX"),
      enemyFormation: formationOf("UNIT_TEX"),
    });

    try {
      runPreflight(cmd, categorySnapshot(), "TACTICAL_EXERCISE");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("INVALID_COMMAND");
      const violations = (error as ApplicationError).violations;
      expect(violations).toHaveLength(1);
      expect(violations).toContainEqual(
        expect.objectContaining({ path: "allyFormation.slots[0].unitDefinitionId" }),
      );
    }
  });

  it("UT-R-TEX-11-005: TACTICAL_EXERCISE accepts a PLAYABLE ally against an EXERCISE_ENEMY enemy", () => {
    const cmd = command({ enemyFormation: formationOf("UNIT_TEX") });

    expect(() => runPreflight(cmd, categorySnapshot(), "TACTICAL_EXERCISE")).not.toThrow();
  });

  it("UT-R-TEX-11-006: an inactive (exerciseActive: false) EXERCISE_ENEMY unit is still accepted — the flag is display-only", () => {
    const cmd = command({ enemyFormation: formationOf("UNIT_TEX") });

    expect(() => runPreflight(cmd, categorySnapshot(false), "TACTICAL_EXERCISE")).not.toThrow();
  });

  it("UT-R-TEX-11-007: an unknown reference still wins over the category check, since it needs a resolved definition", () => {
    const cmd = command({ enemyFormation: formationOf("UNIT_MISSING") });

    try {
      runPreflight(cmd, categorySnapshot(), "TACTICAL_EXERCISE");
      expect.fail("expected runPreflight to throw");
    } catch (error) {
      expect((error as ApplicationError).code).toBe("DEFINITION_NOT_FOUND");
    }
  });
});
