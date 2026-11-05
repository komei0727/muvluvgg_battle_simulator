import { describe, expect, it } from "vitest";
import {
  TOTAL_WAR_TURN_LIMIT,
  validateTotalWarCommandShape,
  type SimulateTotalWarCommand,
} from "./simulate-total-war-command.js";
import type { FormationInput } from "./simulate-battle-command.js";
import { createMemoryDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { formationSlot } from "../../testing/scenario/definition-builders.js";

function formation(unitIds: readonly string[], memoryIds: readonly string[] = []): FormationInput {
  return {
    slots: unitIds.map((unitId, index) =>
      formationSlot(unitId, (index % 3) as 0 | 1 | 2, index < 3 ? "FRONT" : "REAR"),
    ),
    memoryDefinitionIds: memoryIds.map((memoryId) => createMemoryDefinitionId(memoryId)),
  };
}

function command(overrides: Partial<SimulateTotalWarCommand> = {}): SimulateTotalWarCommand {
  return {
    allyFormations: [formation(["UNIT_A"])],
    enemyFormations: [formation(["UNIT_B"])],
    logLevel: "SUMMARY",
    ...overrides,
  };
}

describe("validateTotalWarCommandShape", () => {
  it("UT-TWCOMMAND-001 [R-TWR-01] (R-TWR-01 #5): the total war turn limit is fixed at 15", () => {
    expect(TOTAL_WAR_TURN_LIMIT).toBe(15);
  });

  it("UT-TWCOMMAND-002 [R-TWR-01] (R-TWR-01 #1): accepts one to three formations per side, including the same unit in different formations", () => {
    expect(validateTotalWarCommandShape(command())).toEqual([]);
    expect(
      validateTotalWarCommandShape(
        command({
          allyFormations: [formation(["UNIT_A"]), formation(["UNIT_A"]), formation(["UNIT_A"])],
          enemyFormations: [formation(["UNIT_B"], ["MEM_1"]), formation(["UNIT_B"], ["MEM_1"])],
        }),
      ),
    ).toEqual([]);
  });

  it("UT-TWCOMMAND-003 [R-TWR-01] (R-TWR-01 #1): rejects a side with zero or more than three formations, with the side's path", () => {
    const violations = validateTotalWarCommandShape(
      command({
        allyFormations: [],
        enemyFormations: [
          formation(["UNIT_B"]),
          formation(["UNIT_B"]),
          formation(["UNIT_B"]),
          formation(["UNIT_B"]),
        ],
      }),
    );

    expect(violations.map((violation) => violation.path)).toEqual([
      "allyFormations",
      "enemyFormations",
    ]);
  });

  it("UT-TWCOMMAND-004 [R-TWR-01] (R-TWR-01 #3): rejects the same unitDefinitionId twice within one formation, with the formation index in the path", () => {
    const violations = validateTotalWarCommandShape(
      command({
        allyFormations: [formation(["UNIT_A"]), formation(["UNIT_A", "UNIT_C", "UNIT_A"])],
      }),
    );

    expect(violations).toEqual([
      expect.objectContaining({ path: "allyFormations[1].slots[2].unitDefinitionId" }),
    ]);
  });

  it("UT-TWCOMMAND-005 [R-TWR-01] (R-TWR-01 #4): rejects the same memory twice within one formation, with the formation index in the path", () => {
    const violations = validateTotalWarCommandShape(
      command({ enemyFormations: [formation(["UNIT_B"], ["MEM_1", "MEM_2", "MEM_1"])] }),
    );

    expect(violations).toEqual([
      expect.objectContaining({ path: "enemyFormations[0].memoryDefinitionIds[2]" }),
    ]);
  });

  it("UT-TWCOMMAND-006 [R-FRM-01] (R-FRM-01): applies the normal formation shape rules to every formation and collects all violations", () => {
    const violations = validateTotalWarCommandShape(
      command({
        allyFormations: [formation(["UNIT_A"]), formation([])],
        enemyFormations: [formation(["UNIT_B", "UNIT_C", "UNIT_D", "UNIT_E", "UNIT_F", "UNIT_G"])],
        logLevel: "DIAGNOSTIC" as SimulateTotalWarCommand["logLevel"],
      }),
    );

    expect(violations.map((violation) => violation.path)).toEqual(
      expect.arrayContaining(["allyFormations[1].slots", "enemyFormations[0].slots", "logLevel"]),
    );
  });
});
