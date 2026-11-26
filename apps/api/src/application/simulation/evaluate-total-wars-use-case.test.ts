import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import type {
  EvaluateTotalWarsCommand,
  TotalWarEvaluationCaseInput,
} from "./evaluate-total-wars-command.js";
import {
  EvaluateTotalWarsUseCase,
  type EvaluateTotalWarsUseCaseDependencies,
} from "./evaluate-total-wars-use-case.js";
import { SimulateTotalWarUseCase } from "./simulate-total-war-use-case.js";
import type { FormationInput } from "./simulate-battle-command.js";
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

const SEED = "issue-883-total-war";
const ENGINE_REVISION = "engine-test";
const CONTEXT = { requestId: "test", deadlineEpochMs: Number.MAX_SAFE_INTEGER };

/**
 * `UNIT_STRIKER`は毎ターン1手で出撃中の編成を倒し得る。`UNIT_BRAWLER`同士は会心で
 * 勝敗が揺れる。`UNIT_IDLE`は攻撃手段を持たず、`UNIT_IDLE`同士は規定ターンまで決着しない。
 */
function totalWarCatalog(): TestBattleCatalog {
  return new CatalogBuilder()
    .withUnit(
      unitDefinition("UNIT_STRIKER", {
        baseStats: { maximumAp: 1, attack: 999 },
        activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
      }),
      unitDefinition("UNIT_BRAWLER", {
        baseStats: { maximumHp: 60, attack: 20, defense: 5, criticalRate: 0.5, maximumAp: 1 },
        activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
      }),
      unitDefinition("UNIT_IDLE", { baseStats: { maximumHp: 500, defense: 0 } }),
      unitDefinition("UNIT_TEX", { category: "EXERCISE_ENEMY", exerciseActive: true }),
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

function warCase(
  overrides: Partial<TotalWarEvaluationCaseInput> = {},
): TotalWarEvaluationCaseInput {
  return {
    caseId: "war-a",
    allyFormations: [formation("UNIT_BRAWLER"), formation("UNIT_BRAWLER")],
    enemyFormations: [formation("UNIT_BRAWLER"), formation("UNIT_BRAWLER")],
    runIndices: [0, 1, 2, 3],
    ...overrides,
  };
}

function command(overrides: Partial<EvaluateTotalWarsCommand> = {}): EvaluateTotalWarsCommand {
  return { seed: SEED, cases: [warCase()], ...overrides };
}

function dependencies(clock: Clock = new ManualClock(0)): EvaluateTotalWarsUseCaseDependencies {
  return {
    battleCatalog: totalWarCatalog(),
    battleIdGenerator: new FixedBattleIdGenerator(
      Array.from({ length: 200 }, (_, index) => `B_TWEVAL_${index}`),
    ),
    clock,
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    runtimeInfo: { engineRevision: ENGINE_REVISION },
    limits: { maxCases: 8, maxTotalRuns: 32 },
  };
}

function evaluate(
  input: EvaluateTotalWarsCommand,
  deps: EvaluateTotalWarsUseCaseDependencies = dependencies(),
  context = CONTEXT,
) {
  return new EvaluateTotalWarsUseCase(deps).execute(input, context);
}

function runsByKey(result: ReturnType<typeof evaluate>): Map<string, unknown> {
  return new Map(
    result.cases.flatMap((caseOutcome) =>
      caseOutcome.runs.map((run) => [`${caseOutcome.caseId}#${run.runIndex}`, run.result]),
    ),
  );
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

describe("EvaluateTotalWarsUseCase", () => {
  it("UT-TWEVAL-001: each run is one whole total war matching the single use case given the same seeded random source", () => {
    const caseInput = warCase({ runIndices: [0, 7] });
    const result = evaluate(command({ cases: [caseInput] }));

    expect(result.completedRuns).toBe(2);
    for (const run of result.cases[0]!.runs) {
      const single = new SimulateTotalWarUseCase({
        battleCatalog: totalWarCatalog(),
        battleIdGenerator: new FixedBattleIdGenerator(["B_SINGLE"]),
        clock: new ManualClock(0),
        randomSourceFactory: new Mulberry32SeededRandomSourceProvider().forRun(SEED, run.runIndex),
      }).execute(
        {
          allyFormations: caseInput.allyFormations,
          enemyFormations: caseInput.enemyFormations,
          logLevel: "SUMMARY",
        },
        CONTEXT,
      );

      expect(run.result.outcome).toBe(single.outcome);
      expect(run.result.completionReason).toBe(single.completionReason);
      expect(run.result.completedTurn).toBe(single.completedTurn);
      expect(run.result.stages).toEqual(single.stages);
      expect(run.result.defeatedFormationCounts).toEqual(single.defeatedFormationCounts);
      expect(run.result.units.map((unit) => unit.damageDealt)).toEqual(
        single.unitSummaries.map((summary) => summary.damageDealt),
      );
    }
  });

  it("UT-TWEVAL-002: the same seed reproduces identical runs, and case order or splitting does not change them", () => {
    const caseA = warCase();
    const caseB = warCase({
      caseId: "war-b",
      allyFormations: [formation("UNIT_BRAWLER", "UNIT_IDLE")],
      runIndices: [2, 5],
    });

    const together = runsByKey(evaluate(command({ cases: [caseA, caseB] })));
    expect(runsByKey(evaluate(command({ cases: [caseA, caseB] })))).toEqual(together);
    expect(runsByKey(evaluate(command({ cases: [caseB, caseA] })))).toEqual(together);
    const split = new Map([
      ...runsByKey(evaluate(command({ cases: [{ ...caseA, runIndices: [3, 0] }] }))),
      ...runsByKey(evaluate(command({ cases: [{ ...caseA, runIndices: [1, 2] }, caseB] }))),
    ]);
    expect(split).toEqual(together);
  });

  it("UT-TWEVAL-003: a total war with no decisive attack ends in a DRAW at the fixed turn limit", () => {
    const run = evaluate(
      command({
        cases: [
          warCase({
            allyFormations: [formation("UNIT_IDLE")],
            enemyFormations: [formation("UNIT_IDLE")],
            runIndices: [0],
          }),
        ],
      }),
    ).cases[0]!.runs[0]!.result;

    expect(run.outcome).toBe("DRAW");
    expect(run.completionReason).toBe("TURN_LIMIT_REACHED");
    expect(run.completedTurn).toBe(15);
    expect(run.defeatedFormationCounts).toEqual({ ally: 0, enemy: 0 });
  });

  it("UT-TWEVAL-004: undeployed reserves and reappearing units are reported for every requested slot", () => {
    const run = evaluate(
      command({
        cases: [
          warCase({
            allyFormations: [formation("UNIT_STRIKER"), formation("UNIT_IDLE")],
            enemyFormations: [formation("UNIT_IDLE"), formation("UNIT_IDLE")],
            runIndices: [0],
          }),
        ],
      }),
    ).cases[0]!.runs[0]!.result;

    expect(run.outcome).toBe("ALLY_WIN");
    expect(
      run.stages.map((stage) => [stage.allyFormationNumber, stage.enemyFormationNumber]),
    ).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(
      run.units.map(({ side, formationNumber, unitIndex, deployed, reappearance }) => [
        side,
        formationNumber,
        unitIndex,
        deployed,
        reappearance,
      ]),
    ).toEqual([
      ["ALLY", 1, 0, true, false],
      ["ALLY", 2, 0, false, false],
      ["ENEMY", 1, 0, true, false],
      ["ENEMY", 2, 0, true, true],
    ]);
  });

  it("UT-TWEVAL-005: invalid formations are rejected before any run with case, side, formation and slot in the path", () => {
    const tooMany = captureApplicationError(() =>
      evaluate(
        command({
          cases: [
            warCase(),
            warCase({
              caseId: "war-b",
              allyFormations: [
                formation("UNIT_IDLE"),
                formation("UNIT_IDLE"),
                formation("UNIT_IDLE"),
                formation("UNIT_IDLE"),
              ],
              enemyFormations: [formation("UNIT_IDLE", "UNIT_IDLE")],
            }),
          ],
        }),
      ),
    );
    expect(tooMany.code).toBe("INVALID_COMMAND");
    expect(tooMany.violations.map((violation) => violation.path)).toEqual([
      "cases[1].allyFormations",
      "cases[1].enemyFormations[0].slots[1].unitDefinitionId",
    ]);

    const pool = captureApplicationError(() =>
      evaluate(command({ cases: [warCase({ enemyFormations: [formation("UNIT_TEX")] })] }), {
        ...dependencies(),
        battleIdGenerator: new FixedBattleIdGenerator([]),
      }),
    );
    expect(pool.code).toBe("INVALID_COMMAND");
    expect(pool.violations).toEqual([
      expect.objectContaining({
        path: "cases[0].enemyFormations[0].slots[0].unitDefinitionId",
        ruleId: "R-TEX-11",
      }),
    ]);
  });

  it("UT-TWEVAL-006: an expected engine revision that does not match rejects the request before a single run", () => {
    const error = captureApplicationError(() =>
      evaluate(command({ expectedEngineRevision: "older-engine" }), {
        ...dependencies(),
        battleIdGenerator: new FixedBattleIdGenerator([]),
      }),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations.map((violation) => violation.path)).toEqual(["expectedEngineRevision"]);
  });

  it("UT-TWEVAL-007: a deadline that lands inside a total war leaves that whole run incomplete", () => {
    const clock = new ManualClock(0);
    const advancingClock: Clock = {
      now: () => {
        clock.advance(1);
        return clock.now();
      },
    };

    const partial = evaluate(command(), dependencies(advancingClock), {
      requestId: "test",
      deadlineEpochMs: 20,
    });
    const full = runsByKey(evaluate(command()));

    expect(partial.partial).toBe(true);
    expect(partial.completedRuns).toBeLessThan(4);
    const caseOutcome = partial.cases[0]!;
    expect([
      ...caseOutcome.runs.map((run) => run.runIndex),
      ...caseOutcome.incompleteRunIndices,
    ]).toEqual([0, 1, 2, 3]);
    for (const [key, value] of runsByKey(partial)) {
      expect(value).toEqual(full.get(key));
    }
  });
});
