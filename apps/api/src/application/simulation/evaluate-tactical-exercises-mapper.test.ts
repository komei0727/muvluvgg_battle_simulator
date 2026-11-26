import { describe, expect, it } from "vitest";
import {
  toEvaluateTacticalExercisesCommand,
  toTacticalExerciseEvaluationResponseBody,
} from "./evaluate-tactical-exercises-mapper.js";
import type { EvaluateTacticalExercisesResult } from "./evaluate-tactical-exercises-use-case.js";
import type { TacticalExerciseEvaluationRequestBody } from "../contracts/request.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";

const ALLY = {
  units: [
    { unitDefinitionId: "UNIT_B", position: { column: 2, row: "REAR" } },
    { unitDefinitionId: "UNIT_A", position: { column: 0, row: "FRONT" } },
  ],
  memoryDefinitionIds: ["MEM_2", "MEM_1"],
};
const ENEMY = {
  units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 1, row: "FRONT" } }],
  memoryDefinitionIds: [],
};

describe("toEvaluateTacticalExercisesCommand", () => {
  it("UT-TEXEVALMAP-001: keeps unit, memory and run index order, uses the given seed and passes expected revisions through", () => {
    const body: TacticalExerciseEvaluationRequestBody = {
      seed: "s",
      expectedEngineRevision: "eng",
      cases: [{ caseId: "c", allyFormation: ALLY, enemyFormation: ENEMY, runIndices: [42, 0, 1] }],
    };

    const command = toEvaluateTacticalExercisesCommand(body);

    expect(command.seed).toBe("s");
    expect(command.expectedEngineRevision).toBe("eng");
    expect("expectedCatalogRevision" in command).toBe(false);
    expect(command.cases[0]!.caseId).toBe("c");
    expect(command.cases[0]!.runIndices).toEqual([42, 0, 1]);
    expect(command.cases[0]!.allyFormation.slots.map((slot) => slot.unitDefinitionId)).toEqual([
      "UNIT_B",
      "UNIT_A",
    ]);
    expect(command.cases[0]!.allyFormation.memoryDefinitionIds).toEqual(["MEM_2", "MEM_1"]);
    expect(command.cases[0]!.enemyFormation.slots.map((slot) => slot.unitDefinitionId)).toEqual([
      "UNIT_ENEMY",
    ]);
  });
});

describe("toTacticalExerciseEvaluationResponseBody", () => {
  it("UT-TEXEVALMAP-002: writes each completed run as a self-contained record and keeps incomplete indices", () => {
    const unitA = createUnitDefinitionId("UNIT_A");
    const result: EvaluateTacticalExercisesResult = {
      seed: "s",
      seedDerivationVersion: "V1",
      catalogRevision: "cat",
      engineRevision: "eng",
      requestedRuns: 3,
      completedRuns: 1,
      partial: true,
      cases: [
        {
          caseId: "c",
          runs: [
            {
              runIndex: 42,
              result: {
                totalScore: 1234,
                breakCount: 2,
                completionReason: "TURN_LIMIT_REACHED",
                completedTurn: 5,
                units: [
                  {
                    side: "ALLY",
                    unitIndex: 0,
                    unitDefinitionId: unitA,
                    damageDealt: 5,
                    damageTaken: 0,
                    healingDone: 0,
                    finalHp: 10,
                    maximumHp: 10,
                    combatStatus: "ACTIVE",
                  },
                ],
                allyUnitBreaks: [{ unitIndex: 0, unitDefinitionId: unitA, breakCount: 1 }],
              },
            },
          ],
          incompleteRunIndices: [0, 1],
        },
      ],
    };

    expect(toTacticalExerciseEvaluationResponseBody(result)).toEqual({
      schemaVersion: 1,
      seed: "s",
      seedDerivationVersion: "V1",
      catalogRevision: "cat",
      engineRevision: "eng",
      requestedRuns: 3,
      completedRuns: 1,
      partial: true,
      cases: [
        {
          caseId: "c",
          runs: [
            {
              runIndex: 42,
              totalScore: 1234,
              breakCount: 2,
              completionReason: "TURN_LIMIT_REACHED",
              completedTurn: 5,
              units: [
                {
                  side: "ALLY",
                  unitIndex: 0,
                  unitDefinitionId: "UNIT_A",
                  damageDealt: 5,
                  damageTaken: 0,
                  healingDone: 0,
                  finalHp: 10,
                  maximumHp: 10,
                  combatStatus: "ACTIVE",
                },
              ],
              allyUnitBreaks: [{ unitIndex: 0, unitDefinitionId: "UNIT_A", breakCount: 1 }],
            },
          ],
          incompleteRunIndices: [0, 1],
        },
      ],
    });
  });
});
