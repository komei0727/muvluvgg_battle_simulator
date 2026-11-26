import { describe, expect, it } from "vitest";
import {
  toBattleEvaluationResponseBody,
  toEvaluateBattlesCommand,
} from "./evaluate-battles-mapper.js";
import type { EvaluateBattlesResult } from "./evaluate-battles-use-case.js";
import type { BattleEvaluationRequestBody } from "../contracts/request.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";

const FORMATION = {
  units: [
    { unitDefinitionId: "UNIT_B", position: { column: 2, row: "REAR" } },
    { unitDefinitionId: "UNIT_A", position: { column: 0, row: "FRONT" } },
  ],
  memoryDefinitionIds: ["MEM_2", "MEM_1"],
};

describe("toEvaluateBattlesCommand", () => {
  it("UT-BEVALMAP-001: keeps unit, memory and run index order and passes expected revisions through", () => {
    const body: BattleEvaluationRequestBody = {
      seed: "s",
      expectedCatalogRevision: "cat",
      cases: [
        {
          caseId: "c",
          allyFormation: FORMATION,
          enemyFormation: FORMATION,
          turnLimit: 7,
          runIndices: [42, 0, 1],
        },
      ],
    };

    const command = toEvaluateBattlesCommand(body);

    expect(command.expectedCatalogRevision).toBe("cat");
    expect("expectedEngineRevision" in command).toBe(false);
    expect(command.cases[0]!.runIndices).toEqual([42, 0, 1]);
    expect(command.cases[0]!.turnLimit).toBe(7);
    expect(command.cases[0]!.allyFormation.slots.map((slot) => slot.unitDefinitionId)).toEqual([
      "UNIT_B",
      "UNIT_A",
    ]);
    expect(command.cases[0]!.allyFormation.memoryDefinitionIds).toEqual(["MEM_2", "MEM_1"]);
  });
});

describe("toBattleEvaluationResponseBody", () => {
  it("UT-BEVALMAP-002: flattens each completed run with its run index and keeps incomplete indices", () => {
    const result: EvaluateBattlesResult = {
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
                outcome: "ALLY_WIN",
                completionReason: "ENEMY_DEFEATED",
                completedTurn: 2,
                units: [
                  {
                    side: "ALLY",
                    unitIndex: 0,
                    unitDefinitionId: createUnitDefinitionId("UNIT_A"),
                    damageDealt: 5,
                    damageTaken: 0,
                    healingDone: 0,
                    finalHp: 10,
                    maximumHp: 10,
                    combatStatus: "ACTIVE",
                  },
                ],
              },
            },
          ],
          incompleteRunIndices: [0, 1],
        },
      ],
    };

    expect(toBattleEvaluationResponseBody(result)).toEqual({
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
              outcome: "ALLY_WIN",
              completionReason: "ENEMY_DEFEATED",
              completedTurn: 2,
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
            },
          ],
          incompleteRunIndices: [0, 1],
        },
      ],
    });
  });
});
