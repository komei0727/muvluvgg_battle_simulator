import { describe, expect, it } from "vitest";
import {
  validateEvaluateTacticalExercisesCommandShape,
  type EvaluateTacticalExercisesCommand,
  type TacticalExerciseEvaluationCaseInput,
} from "./evaluate-tactical-exercises-command.js";
import type { FormationInput } from "./simulate-battle-command.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

const LIMITS = { maxCases: 4, maxTotalRuns: 6 };

function formation(...unitIds: string[]): FormationInput {
  return {
    slots: unitIds.map((unitId, index) => ({
      unitDefinitionId: createUnitDefinitionId(unitId),
      position: { column: index as 0 | 1 | 2, row: "FRONT" as const },
    })),
    memoryDefinitionIds: [],
  };
}

function exerciseCase(
  overrides: Partial<TacticalExerciseEvaluationCaseInput> = {},
): TacticalExerciseEvaluationCaseInput {
  return {
    caseId: "case-a",
    allyFormation: formation("UNIT_ALLY"),
    enemyFormation: formation("UNIT_ENEMY"),
    runIndices: [0, 1],
    ...overrides,
  };
}

function command(
  overrides: Partial<EvaluateTacticalExercisesCommand> = {},
): EvaluateTacticalExercisesCommand {
  return { seed: "seed", cases: [exerciseCase()], ...overrides };
}

function paths(input: EvaluateTacticalExercisesCommand): (string | undefined)[] {
  return validateEvaluateTacticalExercisesCommandShape(input, LIMITS).map((v) => v.path);
}

describe("validateEvaluateTacticalExercisesCommandShape", () => {
  it("UT-TEXEVALCMD-001: a well-formed command with non-contiguous run indices produces no violations", () => {
    expect(
      validateEvaluateTacticalExercisesCommandShape(
        command({ cases: [exerciseCase({ runIndices: [0, 1, 42] })] }),
        LIMITS,
      ),
    ).toEqual([]);
  });

  it("UT-TEXEVALCMD-002 [R-TEX-01]: an enemy formation that is not exactly one unit is reported under its case", () => {
    expect(
      paths(
        command({
          cases: [
            exerciseCase(),
            exerciseCase({ caseId: "b", enemyFormation: formation("UNIT_ENEMY", "UNIT_ENEMY") }),
          ],
        }),
      ),
    ).toEqual(["cases[1].enemyFormation.slots"]);
  });

  it("UT-TEXEVALCMD-003 [R-TEX-01]: enemy memories are rejected per case", () => {
    expect(
      paths(
        command({
          cases: [
            exerciseCase({
              enemyFormation: {
                ...formation("UNIT_ENEMY"),
                memoryDefinitionIds: [createMemoryDefinitionId("MEM_X")],
              },
            }),
          ],
        }),
      ),
    ).toEqual(["cases[0].enemyFormation.memoryDefinitionIds"]);
  });

  it("UT-TEXEVALCMD-004: an empty ally formation is reported under its case", () => {
    expect(paths(command({ cases: [exerciseCase({ allyFormation: formation() })] }))).toEqual([
      "cases[0].allyFormation.slots",
    ]);
  });

  it("UT-TEXEVALCMD-005: duplicate case IDs, duplicate run indices and the summed run limit are checked by the shared rules", () => {
    expect(
      paths(
        command({
          seed: " ",
          cases: [
            exerciseCase({ runIndices: [0, 0] }),
            exerciseCase({ runIndices: [1, 2, 3, 4, 5] }),
          ],
        }),
      ),
    ).toEqual(["seed", "cases[0].runIndices[1]", "cases[1].caseId", "cases"]);
  });
});
