import { describe, expect, it } from "vitest";
import {
  toEvaluateTacticalExerciseCandidatesCommand,
  toTacticalExerciseEvaluationResponseBody,
} from "./evaluate-tactical-exercise-candidates-mapper.js";
import type { EvaluateTacticalExerciseCandidatesResult } from "./evaluate-tactical-exercise-candidates-use-case.js";
import type { TacticalExerciseEvaluationRequestBody } from "../contracts/request.js";

function requestBody(
  overrides: Partial<TacticalExerciseEvaluationRequestBody> = {},
): TacticalExerciseEvaluationRequestBody {
  return {
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_ENEMY", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    candidates: [
      {
        allyFormation: {
          units: [{ unitDefinitionId: "UNIT_ALLY", position: { column: 1, row: "REAR" } }],
          memoryDefinitionIds: ["MEM_ONE"],
        },
      },
    ],
    runsPerCandidate: 5,
    ...overrides,
  };
}

describe("toEvaluateTacticalExerciseCandidatesCommand", () => {
  it("UT-EVALMAP-001: candidates keep their request order so that the response can be read positionally", () => {
    const command = toEvaluateTacticalExerciseCandidatesCommand(
      requestBody({
        candidates: [
          {
            allyFormation: {
              units: [{ unitDefinitionId: "UNIT_FIRST", position: { column: 0, row: "FRONT" } }],
              memoryDefinitionIds: [],
            },
          },
          {
            allyFormation: {
              units: [{ unitDefinitionId: "UNIT_SECOND", position: { column: 0, row: "FRONT" } }],
              memoryDefinitionIds: [],
            },
          },
        ],
      }),
      "generated-seed",
    );

    expect(
      command.candidates.map((candidate) => candidate.allyFormation.slots[0]?.unitDefinitionId),
    ).toEqual(["UNIT_FIRST", "UNIT_SECOND"]);
  });

  it("UT-EVALMAP-002: the formation conversion matches the single-exercise endpoint (positions and memory order)", () => {
    const command = toEvaluateTacticalExerciseCandidatesCommand(requestBody(), "generated-seed");

    expect(command.candidates[0]?.allyFormation.slots[0]?.position).toEqual({
      column: 1,
      row: "REAR",
    });
    expect(command.candidates[0]?.allyFormation.memoryDefinitionIds).toEqual(["MEM_ONE"]);
    expect(command.enemyFormation.slots[0]?.unitDefinitionId).toBe("UNIT_ENEMY");
  });

  it("UT-EVALMAP-003: an omitted seed is filled from the supplied fallback so the command is always reproducible", () => {
    const command = toEvaluateTacticalExerciseCandidatesCommand(requestBody(), "generated-seed");

    expect(command.seed).toBe("generated-seed");
  });

  it("UT-EVALMAP-004: an explicit seed wins over the fallback", () => {
    const command = toEvaluateTacticalExerciseCandidatesCommand(
      requestBody({ seed: "client-seed" }),
      "generated-seed",
    );

    expect(command.seed).toBe("client-seed");
  });
});

describe("toTacticalExerciseEvaluationResponseBody", () => {
  const result: EvaluateTacticalExerciseCandidatesResult = {
    catalogRevision: "rev-9",
    seed: "abc123",
    runsPerCandidate: 3,
    candidates: [
      {
        completedRuns: 2,
        scores: [100, 200],
        breakCounts: [1, 2],
        completedTurns: [5, 5],
        completionReasons: ["TURN_LIMIT_REACHED", "ALLY_DEFEATED"],
      },
    ],
  };

  it("UT-EVALMAP-005: every field of the use case result reaches the response body", () => {
    expect(toTacticalExerciseEvaluationResponseBody(result)).toEqual({
      schemaVersion: 1,
      catalogRevision: "rev-9",
      seed: "abc123",
      runsPerCandidate: 3,
      candidates: [
        {
          completedRuns: 2,
          scores: [100, 200],
          breakCounts: [1, 2],
          completedTurns: [5, 5],
          completionReasons: ["TURN_LIMIT_REACHED", "ALLY_DEFEATED"],
        },
      ],
    });
  });

  it("UT-EVALMAP-006: a partially completed candidate keeps completedRuns aligned with the array lengths", () => {
    const body = toTacticalExerciseEvaluationResponseBody(result);

    const candidate = body.candidates[0]!;
    expect(candidate.scores).toHaveLength(candidate.completedRuns);
    expect(candidate.breakCounts).toHaveLength(candidate.completedRuns);
    expect(candidate.completedTurns).toHaveLength(candidate.completedRuns);
    expect(candidate.completionReasons).toHaveLength(candidate.completedRuns);
    expect(candidate.completedRuns).toBeLessThan(body.runsPerCandidate);
  });
});
