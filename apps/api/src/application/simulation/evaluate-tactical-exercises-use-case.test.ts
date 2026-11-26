import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import type {
  EvaluateTacticalExercisesCommand,
  TacticalExerciseEvaluationCaseInput,
} from "./evaluate-tactical-exercises-command.js";
import {
  EvaluateTacticalExercisesUseCase,
  type EvaluateTacticalExercisesUseCaseDependencies,
} from "./evaluate-tactical-exercises-use-case.js";
import type { FormationInput } from "./simulate-battle-command.js";
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

const SEED = "issue-891";
const ENGINE_REVISION = "engine-test";
const CONTEXT = { requestId: "test", deadlineEpochMs: Number.MAX_SAFE_INTEGER };

/**
 * 味方だけが攻撃し、会心の有無でスコアが試行ごとに揺れる演習Catalog。`enemyMaximumHp`を
 * 下げると味方の攻撃だけで規定ターン内にブレイクが発生する（R-TEX-04）。
 */
function exerciseCatalog(enemyMaximumHp = 100000): TestBattleCatalog {
  const attacker = (id: string) =>
    unitDefinition(id, {
      baseStats: { attack: 50, criticalRate: 0.5, maximumAp: 1 },
      activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
    });
  return new CatalogBuilder()
    .withUnit(
      attacker("UNIT_ALLY"),
      attacker("UNIT_OTHER_ALLY"),
      unitDefinition("UNIT_IDLE_ALLY", {
        baseStats: { maximumAp: 0 },
        activeSkillDefinitionIds: [],
      }),
      unitDefinition("UNIT_ENEMY", {
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        baseStats: { maximumHp: enemyMaximumHp, defense: 0 },
      }),
      unitDefinition("UNIT_OTHER_ENEMY", {
        category: "EXERCISE_ENEMY",
        exerciseActive: true,
        baseStats: { maximumHp: enemyMaximumHp * 2, defense: 10 },
      }),
    )
    .withSkill(attackSkill("SKL_ATTACK", "ACT_ATTACK"))
    .withEffectAction(damageEffectAction("ACT_ATTACK"))
    .build();
}

function formation(...unitIds: string[]): FormationInput {
  return {
    slots: unitIds.map((unitId, index) => formationSlot(unitId, index as 0 | 1 | 2)),
    memoryDefinitionIds: [],
  };
}

function exerciseCase(
  overrides: Partial<TacticalExerciseEvaluationCaseInput> = {},
): TacticalExerciseEvaluationCaseInput {
  return {
    caseId: "case-a",
    allyFormation: formation("UNIT_ALLY", "UNIT_ALLY"),
    enemyFormation: formation("UNIT_ENEMY"),
    runIndices: [0, 1, 2, 3],
    ...overrides,
  };
}

function command(
  overrides: Partial<EvaluateTacticalExercisesCommand> = {},
): EvaluateTacticalExercisesCommand {
  return { seed: SEED, cases: [exerciseCase()], ...overrides };
}

function dependencies(
  catalog: TestBattleCatalog = exerciseCatalog(),
  clock: Clock = new ManualClock(0),
): EvaluateTacticalExercisesUseCaseDependencies {
  return {
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(
      Array.from({ length: 200 }, (_, index) => `B_TEXEVAL_${index}`),
    ),
    clock,
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    runtimeInfo: { engineRevision: ENGINE_REVISION },
    limits: { maxCases: 8, maxTotalRuns: 64 },
  };
}

function evaluate(
  input: EvaluateTacticalExercisesCommand,
  deps: EvaluateTacticalExercisesUseCaseDependencies = dependencies(),
  context = CONTEXT,
) {
  return new EvaluateTacticalExercisesUseCase(deps).execute(input, context);
}

function captureApplicationError(execute: () => unknown): ApplicationError {
  try {
    execute();
  } catch (error) {
    if (error instanceof ApplicationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an ApplicationError");
}

function runsByKey(result: ReturnType<typeof evaluate>): Map<string, unknown> {
  return new Map(
    result.cases.flatMap((caseOutcome) =>
      caseOutcome.runs.map((run) => [`${caseOutcome.caseId}#${run.runIndex}`, run.result]),
    ),
  );
}

function advancingClock(step: number): Clock {
  const clock = new ManualClock(0);
  return {
    now: () => {
      clock.advance(step);
      return clock.now();
    },
  };
}

describe("EvaluateTacticalExercisesUseCase", () => {
  it("UT-TEXEVAL-001: the same seed and run indices reproduce identical observations, and run indices change the stream", () => {
    const first = evaluate(command());
    const second = evaluate(command());

    expect(first.completedRuns).toBe(4);
    expect(second.cases).toEqual(first.cases);
    const scores = first.cases[0]!.runs.map((run) => run.result.totalScore);
    expect(new Set(scores).size).toBeGreaterThan(1);
  });

  it("UT-TEXEVAL-002: request splitting, case order and co-located cases do not change the result of a given run", () => {
    const caseA = exerciseCase({ runIndices: [0, 1, 42] });
    const caseB = exerciseCase({
      caseId: "case-b",
      allyFormation: formation("UNIT_OTHER_ALLY"),
      enemyFormation: formation("UNIT_OTHER_ENEMY"),
      runIndices: [42, 7],
    });

    const together = runsByKey(evaluate(command({ cases: [caseA, caseB] })));
    const reversed = runsByKey(evaluate(command({ cases: [caseB, caseA] })));
    const split = new Map([
      ...runsByKey(evaluate(command({ cases: [{ ...caseA, runIndices: [42] }] }))),
      ...runsByKey(evaluate(command({ cases: [{ ...caseA, runIndices: [1, 0] }] }))),
      ...runsByKey(evaluate(command({ cases: [caseB] }))),
    ]);

    expect(together.size).toBe(5);
    expect(reversed).toEqual(together);
    expect(split).toEqual(together);
  });

  it("UT-TEXEVAL-003 [R-TEX-02]: each run matches the single exercise use case given the same seeded random source", () => {
    const catalog = exerciseCatalog(400);
    const caseInput = exerciseCase({ runIndices: [0, 42] });
    const result = evaluate(command({ cases: [caseInput] }), dependencies(catalog));

    for (const run of result.cases[0]!.runs) {
      const single = new SimulateTacticalExerciseUseCase({
        battleCatalog: catalog,
        battleIdGenerator: new FixedBattleIdGenerator(["B_SINGLE"]),
        clock: new ManualClock(0),
        randomSourceFactory: new Mulberry32SeededRandomSourceProvider().forRun(SEED, run.runIndex),
      }).execute(
        {
          allyFormation: caseInput.allyFormation,
          enemyFormation: caseInput.enemyFormation,
          logLevel: "SUMMARY",
        },
        CONTEXT,
      );

      expect(run.result.totalScore).toBe(single.totalScore);
      expect(run.result.breakCount).toBe(single.breakCount);
      expect(run.result.completionReason).toBe(single.completionReason);
      expect(run.result.completedTurn).toBe(single.completedTurn);
      expect(run.result.units.map((unit) => unit.damageDealt)).toEqual(
        single.unitSummaries.map((summary) => summary.damageDealt),
      );
      expect(run.result.units.map((unit) => unit.finalHp)).toEqual(
        single.unitSummaries.map((summary) => summary.finalHp),
      );
    }
  });

  it("UT-TEXEVAL-004 [R-TEX-03]: two slots holding the same unit stay distinguishable, and their breaks add up to the run's break count", () => {
    const run = evaluate(command(), dependencies(exerciseCatalog(1))).cases[0]!.runs[0]!.result;

    expect(
      run.units.map(({ side, unitIndex, unitDefinitionId }) => [side, unitIndex, unitDefinitionId]),
    ).toEqual([
      ["ALLY", 0, "UNIT_ALLY"],
      ["ALLY", 1, "UNIT_ALLY"],
      ["ENEMY", 0, "UNIT_ENEMY"],
    ]);
    expect(run.breakCount).toBeGreaterThan(0);
    expect(
      run.allyUnitBreaks.map(({ unitIndex, unitDefinitionId }) => [unitIndex, unitDefinitionId]),
    ).toEqual([
      [0, "UNIT_ALLY"],
      [1, "UNIT_ALLY"],
    ]);
    // 味方2枠だけが攻撃するため、全ブレイクがどちらかの枠へ帰属する。
    expect(run.allyUnitBreaks.reduce((sum, entry) => sum + entry.breakCount, 0)).toBe(
      run.breakCount,
    );
  });

  it("UT-TEXEVAL-005: the result carries the seed, derivation version, catalog and engine revisions", () => {
    const catalog = exerciseCatalog();
    const result = evaluate(command(), dependencies(catalog));

    expect(result).toMatchObject({
      seed: SEED,
      seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
      catalogRevision: catalog.catalogRevision,
      engineRevision: ENGINE_REVISION,
      requestedRuns: 4,
      completedRuns: 4,
      partial: false,
    });
  });

  it("UT-TEXEVAL-006 [R-TEX-11]: an EXERCISE_ENEMY unit used as an ally in a later case rejects the request with the case index in the path", () => {
    const error = captureApplicationError(() =>
      evaluate(
        command({
          cases: [
            exerciseCase(),
            exerciseCase({ caseId: "b", allyFormation: formation("UNIT_ENEMY") }),
          ],
        }),
        { ...dependencies(), battleIdGenerator: new FixedBattleIdGenerator([]) },
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(
      error.violations.some(
        (violation) =>
          violation.ruleId === "R-TEX-11" &&
          violation.path === "cases[1].allyFormation.slots[0].unitDefinitionId",
      ),
    ).toBe(true);
  });

  it("UT-TEXEVAL-007: an unknown unit in any case rejects the whole request before a single run", () => {
    const catalog = exerciseCatalog();
    const error = captureApplicationError(() =>
      evaluate(
        command({
          cases: [
            exerciseCase(),
            exerciseCase({ caseId: "b", enemyFormation: formation("UNIT_MISSING") }),
          ],
        }),
        { ...dependencies(catalog), battleIdGenerator: new FixedBattleIdGenerator([]) },
      ),
    );

    // 1試行でも始めていればBattleIdの払い出しで失敗するため、到達しないことを示す。
    expect(error.code).toBe("DEFINITION_NOT_FOUND");
    expect(error.violations.map((violation) => violation.path)).toEqual([
      "cases[1].enemyFormation.slots[0].unitDefinitionId",
    ]);
    expect(catalog.loadSnapshotCallCount).toBe(1);
  });

  it("UT-TEXEVAL-008: an expected revision that does not match rejects the request before a single run", () => {
    const error = captureApplicationError(() =>
      evaluate(command({ expectedEngineRevision: "other" }), {
        ...dependencies(),
        battleIdGenerator: new FixedBattleIdGenerator([]),
      }),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations.map((violation) => violation.path)).toEqual(["expectedEngineRevision"]);
  });

  it("UT-TEXEVAL-009: a deadline reached mid-request returns only completed runs and lists the rest without renumbering", () => {
    const caseA = exerciseCase({ runIndices: [0, 5, 9] });
    const caseB = exerciseCase({ caseId: "case-b", runIndices: [2, 4, 6] });

    const partial = evaluate(
      command({ cases: [caseA, caseB] }),
      dependencies(exerciseCatalog(), advancingClock(1)),
      {
        requestId: "test",
        deadlineEpochMs: 9,
      },
    );
    const full = runsByKey(evaluate(command({ cases: [caseA, caseB] })));

    expect(partial.partial).toBe(true);
    expect(partial.completedRuns).toBeGreaterThan(0);
    expect(partial.completedRuns).toBeLessThan(6);
    for (const [index, caseOutcome] of partial.cases.entries()) {
      const requested = [caseA, caseB][index]!.runIndices;
      const reported = [
        ...caseOutcome.runs.map((run) => run.runIndex),
        ...caseOutcome.incompleteRunIndices,
      ];
      expect(reported.sort()).toEqual([...requested].sort());
    }
    for (const [key, value] of runsByKey(partial)) {
      expect(value).toEqual(full.get(key));
    }
  });

  it("UT-TEXEVAL-010: resending only the incomplete run indices completes the original plan without overlap", () => {
    const plan = exerciseCase({ runIndices: [0, 1, 2, 3, 4, 5] });
    const partial = evaluate(
      command({ cases: [plan] }),
      dependencies(exerciseCatalog(), advancingClock(1)),
      {
        requestId: "test",
        deadlineEpochMs: 4,
      },
    );
    const incomplete = partial.cases[0]!.incompleteRunIndices;
    expect(incomplete.length).toBeGreaterThan(0);

    const resumed = evaluate(command({ cases: [{ ...plan, runIndices: [...incomplete] }] }));
    const combined = [...runsByKey(partial), ...runsByKey(resumed)];

    expect(combined.map(([key]) => key).sort()).toEqual(
      plan.runIndices.map((runIndex) => `case-a#${runIndex}`).sort(),
    );
    expect(new Map(combined)).toEqual(runsByKey(evaluate(command({ cases: [plan] }))));
  });

  it("UT-TEXEVAL-011: a deadline already past on entry completes no run but still names every requested run index", () => {
    const result = evaluate(command(), dependencies(exerciseCatalog(), new ManualClock(1000)), {
      requestId: "test",
      deadlineEpochMs: 0,
    });

    expect(result.completedRuns).toBe(0);
    expect(result.partial).toBe(true);
    expect(result.cases[0]!.runs).toEqual([]);
    expect(result.cases[0]!.incompleteRunIndices).toEqual([0, 1, 2, 3]);
  });
});
