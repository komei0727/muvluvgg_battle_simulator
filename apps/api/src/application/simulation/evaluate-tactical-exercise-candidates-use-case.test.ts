import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import {
  EvaluateTacticalExerciseCandidatesUseCase,
  type EvaluateTacticalExerciseCandidatesUseCaseDependencies,
} from "./evaluate-tactical-exercise-candidates-use-case.js";
import type {
  EvaluateTacticalExerciseCandidatesCommand,
  TacticalExerciseCandidateInput,
} from "./evaluate-tactical-exercise-candidates-command.js";
import { SimulateTacticalExerciseUseCase } from "./simulate-tactical-exercise-use-case.js";
import { createSkillDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { Clock } from "../../domain/ports/clock.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { CatalogBuilder, type TestBattleCatalog } from "../../testing/scenario/catalog-builder.js";
import {
  attackSkill,
  damageEffectAction,
  formationSlot,
  unitDefinition,
} from "../../testing/scenario/definition-builders.js";

const ATTACK_SKILL_ID = "SKL_ATTACK";
const ATTACK_ACTION_ID = "ACT_ATTACK";
const SEED = "issue-507";
const LIMITS = { maxCandidates: 8, maxTotalRuns: 64 };

/** 味方だけが攻撃し、敵は何もしない最小の演習Catalog。 */
function exerciseCatalog(): TestBattleCatalog {
  return new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_ALLY", {
        baseStats: { maximumAp: 1 },
        activeSkillDefinitionIds: [createSkillDefinitionId(ATTACK_SKILL_ID)],
      }),
      unitDefinition("UNIT_OTHER_ALLY", {
        baseStats: { maximumAp: 1 },
        activeSkillDefinitionIds: [createSkillDefinitionId(ATTACK_SKILL_ID)],
      }),
      unitDefinition("UNIT_ENEMY", {
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        baseStats: { maximumHp: 1000, defense: 0 },
      }),
    )
    .withSkill(attackSkill(ATTACK_SKILL_ID, ATTACK_ACTION_ID))
    .withEffectAction(damageEffectAction(ATTACK_ACTION_ID))
    .build();
}

function candidate(unitDefinitionId = "UNIT_ALLY"): TacticalExerciseCandidateInput {
  return {
    allyFormation: { slots: [formationSlot(unitDefinitionId, 0)], memoryDefinitionIds: [] },
  };
}

function evaluationCommand(
  overrides: Partial<EvaluateTacticalExerciseCandidatesCommand> = {},
): EvaluateTacticalExerciseCandidatesCommand {
  return {
    enemyFormation: { slots: [formationSlot("UNIT_ENEMY", 0)], memoryDefinitionIds: [] },
    candidates: [candidate()],
    runsPerCandidate: 3,
    seed: SEED,
    ...overrides,
  };
}

function dependencies(
  catalog: TestBattleCatalog,
  clock: Clock = new ManualClock(0),
): EvaluateTacticalExerciseCandidatesUseCaseDependencies {
  return {
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(
      Array.from({ length: 200 }, (_, index) => `B_EVAL_${index}`),
    ),
    clock,
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    limits: LIMITS,
  };
}

const CONTEXT = { requestId: "test", deadlineEpochMs: Number.MAX_SAFE_INTEGER };

function captureApplicationError(execute: () => unknown): ApplicationError {
  try {
    execute();
  } catch (error) {
    if (error instanceof ApplicationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the use case to throw an ApplicationError");
}

describe("EvaluateTacticalExerciseCandidatesUseCase", () => {
  it("UT-EVALUC-001: the same seed reproduces identical scores across separate executions", () => {
    const catalog = exerciseCatalog();

    const first = new EvaluateTacticalExerciseCandidatesUseCase(dependencies(catalog)).execute(
      evaluationCommand(),
      CONTEXT,
    );
    const second = new EvaluateTacticalExerciseCandidatesUseCase(dependencies(catalog)).execute(
      evaluationCommand(),
      CONTEXT,
    );

    expect(first.candidates[0]?.scores).toHaveLength(3);
    expect(second.candidates).toEqual(first.candidates);
  });

  it("UT-EVALUC-002: two identical candidates share one run's random stream, so their scores match exactly (common random numbers)", () => {
    const result = new EvaluateTacticalExerciseCandidatesUseCase(
      dependencies(exerciseCatalog()),
    ).execute(evaluationCommand({ candidates: [candidate(), candidate()] }), CONTEXT);

    expect(result.candidates[0]?.scores).toHaveLength(3);
    expect(result.candidates[1]?.scores).toEqual(result.candidates[0]?.scores);
  });

  it("UT-EVALUC-003: the result echoes the seed, the requested run count, and the catalog revision", () => {
    const catalog = exerciseCatalog();

    const result = new EvaluateTacticalExerciseCandidatesUseCase(dependencies(catalog)).execute(
      evaluationCommand(),
      CONTEXT,
    );

    expect(result.seed).toBe(SEED);
    expect(result.runsPerCandidate).toBe(3);
    expect(result.catalogRevision).toBe(catalog.catalogRevision);
  });

  it("UT-EVALUC-004: every candidate reports one entry per requested run when the deadline is far away", () => {
    const result = new EvaluateTacticalExerciseCandidatesUseCase(
      dependencies(exerciseCatalog()),
    ).execute(
      evaluationCommand({ candidates: [candidate(), candidate("UNIT_OTHER_ALLY")] }),
      CONTEXT,
    );

    expect(result.candidates).toHaveLength(2);
    for (const evaluation of result.candidates) {
      expect(evaluation.completedRuns).toBe(3);
      expect(evaluation.scores).toHaveLength(3);
      expect(evaluation.breakCounts).toHaveLength(3);
      expect(evaluation.completedTurns).toHaveLength(3);
      expect(evaluation.completionReasons).toHaveLength(3);
    }
  });

  it("UT-EVALUC-005: a deadline reached mid-batch returns the completed runs instead of failing the request", () => {
    const clock = new ManualClock(0);
    // Every observation advances time, so the deadline lands partway through the batch.
    const advancingClock: Clock = {
      now: () => {
        clock.advance(10);
        return clock.now();
      },
    };

    const result = new EvaluateTacticalExerciseCandidatesUseCase(
      dependencies(exerciseCatalog(), advancingClock),
    ).execute(evaluationCommand({ candidates: [candidate(), candidate()], runsPerCandidate: 8 }), {
      requestId: "test",
      deadlineEpochMs: 100,
    });

    const completed = result.candidates.reduce(
      (total, evaluation) => total + evaluation.completedRuns,
      0,
    );
    expect(completed).toBeGreaterThan(0);
    expect(completed).toBeLessThan(16);
    expect(result.candidates).toHaveLength(2);
    for (const evaluation of result.candidates) {
      expect(evaluation.scores).toHaveLength(evaluation.completedRuns);
    }
  });

  it("UT-EVALUC-006: a deadline already past on entry yields zero completed runs but still reports the catalog revision", () => {
    const catalog = exerciseCatalog();

    const result = new EvaluateTacticalExerciseCandidatesUseCase(
      dependencies(catalog, new ManualClock(1000)),
    ).execute(evaluationCommand(), { requestId: "test", deadlineEpochMs: 0 });

    expect(result.candidates.map((evaluation) => evaluation.completedRuns)).toEqual([0]);
    expect(result.catalogRevision).toBe(catalog.catalogRevision);
  });

  it("UT-EVALUC-007: a command-shape violation is rejected as INVALID_COMMAND", () => {
    const error = captureApplicationError(() =>
      new EvaluateTacticalExerciseCandidatesUseCase(dependencies(exerciseCatalog())).execute(
        evaluationCommand({ runsPerCandidate: 0 }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations.map((violation) => violation.path)).toContain("runsPerCandidate");
  });

  it("UT-EVALUC-008: an unknown unit inside a candidate reports the candidate index in its violation path", () => {
    const error = captureApplicationError(() =>
      new EvaluateTacticalExerciseCandidatesUseCase(dependencies(exerciseCatalog())).execute(
        evaluationCommand({ candidates: [candidate(), candidate("UNIT_MISSING")] }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("DEFINITION_NOT_FOUND");
    expect(error.violations.map((violation) => violation.path)).toContain(
      "candidates[1].allyFormation.slots[0].unitDefinitionId",
    );
  });

  it("UT-EVALUC-009: an EXERCISE_ENEMY unit used as an ally is rejected per candidate (R-TEX-11)", () => {
    const error = captureApplicationError(() =>
      new EvaluateTacticalExerciseCandidatesUseCase(dependencies(exerciseCatalog())).execute(
        evaluationCommand({ candidates: [candidate("UNIT_ENEMY")] }),
        CONTEXT,
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(
      error.violations.some(
        (violation) =>
          violation.ruleId === "R-TEX-11" &&
          violation.path === "candidates[0].allyFormation.slots[0].unitDefinitionId",
      ),
    ).toBe(true);
  });

  it("UT-EVALUC-010: a shared enemy-formation violation is reported once rather than once per candidate", () => {
    const error = captureApplicationError(() =>
      new EvaluateTacticalExerciseCandidatesUseCase(dependencies(exerciseCatalog())).execute(
        evaluationCommand({
          candidates: [candidate(), candidate(), candidate()],
          enemyFormation: {
            slots: [formationSlot("UNIT_ALLY", 0)],
            memoryDefinitionIds: [],
          },
        }),
        CONTEXT,
      ),
    );

    const enemyViolations = error.violations.filter((violation) =>
      violation.path?.startsWith("enemyFormation"),
    );
    expect(enemyViolations).toHaveLength(1);
  });

  it("UT-EVALUC-012: a candidate violation is detected before any run executes", () => {
    const catalog = exerciseCatalog();

    captureApplicationError(() =>
      new EvaluateTacticalExerciseCandidatesUseCase(dependencies(catalog)).execute(
        evaluationCommand({ candidates: [candidate(), candidate("UNIT_MISSING")] }),
        CONTEXT,
      ),
    );

    // preflight用の1回だけ。実行が始まっていれば試行ごとの読み出しで増える。
    expect(catalog.loadSnapshotCallCount).toBe(1);
  });

  it("UT-EVALUC-011: one candidate with one run scores exactly as the single-exercise use case does for the same run seed", () => {
    const catalog = exerciseCatalog();
    const provider = new Mulberry32SeededRandomSourceProvider();

    const batch = new EvaluateTacticalExerciseCandidatesUseCase(dependencies(catalog)).execute(
      evaluationCommand({ runsPerCandidate: 1 }),
      CONTEXT,
    );
    const single = new SimulateTacticalExerciseUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new FixedBattleIdGenerator(["B_SINGLE"]),
      randomSourceFactory: provider.forRun(SEED, 0),
      clock: new ManualClock(0),
    }).execute(
      {
        allyFormation: evaluationCommand().candidates[0]!.allyFormation,
        enemyFormation: evaluationCommand().enemyFormation,
        logLevel: "SUMMARY",
      },
      CONTEXT,
    );

    expect(batch.candidates[0]?.scores).toEqual([single.totalScore]);
    expect(batch.candidates[0]?.breakCounts).toEqual([single.breakCount]);
    expect(batch.candidates[0]?.completionReasons).toEqual([single.completionReason]);
  });
});
