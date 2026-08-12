import { describe, expect, it } from "vitest";
import {
  EXERCISE_TURN_LIMIT,
  validateTacticalExerciseCommandShape,
  type SimulateTacticalExerciseCommand,
} from "./simulate-tactical-exercise-command.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

function slot(column: 0 | 1 | 2, row: "FRONT" | "REAR" = "FRONT") {
  return { unitDefinitionId: createUnitDefinitionId("UNIT_001"), position: { column, row } };
}

function validCommand(
  overrides: Partial<SimulateTacticalExerciseCommand> = {},
): SimulateTacticalExerciseCommand {
  return {
    allyFormation: { slots: [slot(0)], memoryDefinitionIds: [] },
    enemyFormation: { slots: [slot(1)], memoryDefinitionIds: [] },
    logLevel: "DETAILED",
    ...overrides,
  };
}

describe("validateTacticalExerciseCommandShape", () => {
  it("UT-TEXCMD-001 (R-TEX-01 #4): the exercise turn limit is the fixed value 5, which the Command cannot carry", () => {
    expect(EXERCISE_TURN_LIMIT).toBe(5);
    expect(validCommand()).not.toHaveProperty("turnLimit");
  });

  it("UT-TEXCMD-002: returns no violations for an exercise command with exactly one memory-less enemy", () => {
    expect(validateTacticalExerciseCommandShape(validCommand())).toEqual([]);
  });

  it("UT-TEXCMD-003 (R-TEX-01 #3): rejects an enemy formation with no unit", () => {
    const violations = validateTacticalExerciseCommandShape(
      validCommand({ enemyFormation: { slots: [], memoryDefinitionIds: [] } }),
    );

    expect(violations).toContainEqual({
      path: "enemyFormation.slots",
      reason: "must contain exactly 1 unit in a tactical exercise, got 0",
    });
  });

  it("UT-TEXCMD-004 (R-TEX-01 #3): rejects an enemy formation with two units", () => {
    const violations = validateTacticalExerciseCommandShape(
      validCommand({ enemyFormation: { slots: [slot(0), slot(1)], memoryDefinitionIds: [] } }),
    );

    expect(violations).toContainEqual({
      path: "enemyFormation.slots",
      reason: "must contain exactly 1 unit in a tactical exercise, got 2",
    });
  });

  it("UT-TEXCMD-005 (R-TEX-01 #3): rejects an enemy formation that specifies a memory", () => {
    const violations = validateTacticalExerciseCommandShape(
      validCommand({
        enemyFormation: {
          slots: [slot(1)],
          memoryDefinitionIds: [createMemoryDefinitionId("MEM_001")],
        },
      }),
    );

    expect(violations).toContainEqual({
      path: "enemyFormation.memoryDefinitionIds",
      reason: "must be empty in a tactical exercise, got 1",
    });
  });

  it("UT-TEXCMD-006 (R-TEX-01 #2): keeps applying the ally formation rules (R-FRM-01～05) unchanged", () => {
    const violations = validateTacticalExerciseCommandShape(
      validCommand({
        allyFormation: {
          slots: [slot(0), slot(1), slot(2), slot(0, "REAR"), slot(1, "REAR"), slot(2, "REAR")],
          memoryDefinitionIds: [],
        },
      }),
    );

    expect(violations).toContainEqual(expect.objectContaining({ path: "allyFormation.slots" }));
  });

  it("UT-TEXCMD-007: rejects an unknown logLevel, like the battle command does", () => {
    const violations = validateTacticalExerciseCommandShape(
      validCommand({ logLevel: "VERBOSE" as SimulateTacticalExerciseCommand["logLevel"] }),
    );

    expect(violations).toContainEqual(expect.objectContaining({ path: "logLevel" }));
  });
});
