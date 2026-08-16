import { describe, expect, it } from "vitest";
import {
  validateEvaluateTacticalExerciseCandidatesCommandShape,
  type EvaluateTacticalExerciseCandidatesCommand,
  type EvaluationLimits,
} from "./evaluate-tactical-exercise-candidates-command.js";
import type { FormationInput } from "./simulate-battle-command.js";
import {
  createMemoryDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

const LIMITS: EvaluationLimits = { maxCandidates: 4, maxTotalRuns: 20 };

function allyFormation(): FormationInput {
  return {
    slots: [
      {
        unitDefinitionId: createUnitDefinitionId("UNIT_ALLY"),
        position: { column: 0, row: "FRONT" },
      },
    ],
    memoryDefinitionIds: [],
  };
}

function enemyFormation(): FormationInput {
  return {
    slots: [
      {
        unitDefinitionId: createUnitDefinitionId("UNIT_ENEMY"),
        position: { column: 0, row: "FRONT" },
      },
    ],
    memoryDefinitionIds: [],
  };
}

function command(
  overrides: Partial<EvaluateTacticalExerciseCandidatesCommand> = {},
): EvaluateTacticalExerciseCandidatesCommand {
  return {
    enemyFormation: enemyFormation(),
    candidates: [{ allyFormation: allyFormation() }],
    runsPerCandidate: 2,
    ...overrides,
  };
}

function paths(command: EvaluateTacticalExerciseCandidatesCommand): (string | undefined)[] {
  return validateEvaluateTacticalExerciseCandidatesCommandShape(command, LIMITS).map((v) => v.path);
}

describe("validateEvaluateTacticalExerciseCandidatesCommandShape", () => {
  it("UT-EVALCMD-001: a well-formed command produces no violations", () => {
    expect(validateEvaluateTacticalExerciseCandidatesCommandShape(command(), LIMITS)).toEqual([]);
  });

  it("UT-EVALCMD-002: an empty candidate list is rejected", () => {
    expect(paths(command({ candidates: [] }))).toContain("candidates");
  });

  it("UT-EVALCMD-003: more candidates than the configured maximum are rejected", () => {
    const candidates = Array.from({ length: LIMITS.maxCandidates + 1 }, () => ({
      allyFormation: allyFormation(),
    }));

    expect(paths(command({ candidates, runsPerCandidate: 1 }))).toContain("candidates");
  });

  it("UT-EVALCMD-004: a runsPerCandidate below 1 is rejected", () => {
    expect(paths(command({ runsPerCandidate: 0 }))).toContain("runsPerCandidate");
  });

  it("UT-EVALCMD-005: a non-integer runsPerCandidate is rejected", () => {
    expect(paths(command({ runsPerCandidate: 1.5 }))).toContain("runsPerCandidate");
  });

  it("UT-EVALCMD-006: candidates x runsPerCandidate beyond the total-run budget is rejected even when each field is individually within range", () => {
    const candidates = Array.from({ length: LIMITS.maxCandidates }, () => ({
      allyFormation: allyFormation(),
    }));

    const violations = validateEvaluateTacticalExerciseCandidatesCommandShape(
      command({ candidates, runsPerCandidate: LIMITS.maxTotalRuns }),
      LIMITS,
    );

    expect(violations.map((v) => v.path)).toContain("runsPerCandidate");
    expect(violations.some((v) => v.reason.includes(String(LIMITS.maxTotalRuns)))).toBe(true);
  });

  it("UT-EVALCMD-007: a candidate formation violation carries the candidate index in its path", () => {
    const broken: FormationInput = { slots: [], memoryDefinitionIds: [] };

    expect(
      paths(
        command({
          candidates: [{ allyFormation: allyFormation() }, { allyFormation: broken }],
        }),
      ),
    ).toContain("candidates[1].allyFormation.slots");
  });

  it("UT-EVALCMD-008: the enemy formation must hold exactly one unit (R-TEX-01 #3)", () => {
    const twoUnits: FormationInput = {
      slots: [...enemyFormation().slots, ...enemyFormation().slots],
      memoryDefinitionIds: [],
    };

    expect(paths(command({ enemyFormation: twoUnits }))).toContain("enemyFormation.slots");
  });

  it("UT-EVALCMD-009: the enemy formation must carry no memories (R-TEX-01 #3)", () => {
    const withMemory: FormationInput = {
      slots: enemyFormation().slots,
      memoryDefinitionIds: [createMemoryDefinitionId("MEM_ANY")],
    };

    expect(paths(command({ enemyFormation: withMemory }))).toContain(
      "enemyFormation.memoryDefinitionIds",
    );
  });

  it("UT-EVALCMD-010: the enemy formation is validated once rather than once per candidate", () => {
    const twoUnits: FormationInput = {
      slots: [...enemyFormation().slots, ...enemyFormation().slots],
      memoryDefinitionIds: [],
    };
    const candidates = [
      { allyFormation: allyFormation() },
      { allyFormation: allyFormation() },
      { allyFormation: allyFormation() },
    ];

    const enemyViolations = validateEvaluateTacticalExerciseCandidatesCommandShape(
      command({ enemyFormation: twoUnits, candidates, runsPerCandidate: 1 }),
      LIMITS,
    ).filter((violation) => violation.path === "enemyFormation.slots");

    expect(enemyViolations).toHaveLength(1);
  });

  it("UT-EVALCMD-011: a blank seed is rejected so that the echoed seed always reproduces the run", () => {
    expect(paths(command({ seed: "   " }))).toContain("seed");
  });
});
