import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import type {
  BattleEvaluationCaseInput,
  EvaluateBattlesCommand,
} from "./evaluate-battles-command.js";
import {
  EvaluateBattlesUseCase,
  type EvaluateBattlesUseCaseDependencies,
} from "./evaluate-battles-use-case.js";
import { SimulateBattleUseCase } from "./simulate-battle-use-case.js";
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

const SEED = "issue-883";
const ENGINE_REVISION = "engine-test";
const CONTEXT = { requestId: "test", deadlineEpochMs: Number.MAX_SAFE_INTEGER };

/** 両陣営が殴り合い、会心の有無で勝敗とダメージが試行ごとに揺れる通常戦闘Catalog。 */
function battleCatalog(): TestBattleCatalog {
  const attacker = (id: string) =>
    unitDefinition(id, {
      baseStats: { maximumHp: 60, attack: 20, defense: 5, criticalRate: 0.5, maximumAp: 1 },
      activeSkillDefinitionIds: [createSkillDefinitionId("SKL_ATTACK")],
    });
  return new CatalogBuilder()
    .withUnit(attacker("UNIT_A"), attacker("UNIT_B"))
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

function battleCase(overrides: Partial<BattleEvaluationCaseInput> = {}): BattleEvaluationCaseInput {
  return {
    caseId: "case-a",
    allyFormation: formation("UNIT_A", "UNIT_A"),
    enemyFormation: formation("UNIT_B"),
    turnLimit: 5,
    runIndices: [0, 1, 2, 3],
    ...overrides,
  };
}

function command(overrides: Partial<EvaluateBattlesCommand> = {}): EvaluateBattlesCommand {
  return { seed: SEED, cases: [battleCase()], ...overrides };
}

function dependencies(
  catalog: TestBattleCatalog = battleCatalog(),
  clock: Clock = new ManualClock(0),
): EvaluateBattlesUseCaseDependencies {
  return {
    battleCatalog: catalog,
    battleIdGenerator: new FixedBattleIdGenerator(
      Array.from({ length: 200 }, (_, index) => `B_BEVAL_${index}`),
    ),
    clock,
    seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
    runtimeInfo: { engineRevision: ENGINE_REVISION },
    limits: { maxCases: 8, maxTotalRuns: 64 },
  };
}

function evaluate(
  input: EvaluateBattlesCommand,
  deps: EvaluateBattlesUseCaseDependencies = dependencies(),
  context = CONTEXT,
) {
  return new EvaluateBattlesUseCase(deps).execute(input, context);
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

describe("EvaluateBattlesUseCase", () => {
  it("UT-BEVAL-001: the same seed and run indices reproduce identical observations", () => {
    const first = evaluate(command());
    const second = evaluate(command());

    expect(first.completedRuns).toBe(4);
    expect(second.cases).toEqual(first.cases);
    // 試行番号ごとに乱数列が違うため、少なくとも1つの観測は揺れる。
    const damages = first.cases[0]!.runs.map((run) => run.result.units[0]!.damageDealt);
    expect(new Set(damages).size).toBeGreaterThan(1);
  });

  it("UT-BEVAL-002: case order and request splitting do not change the result of a given run", () => {
    const caseA = battleCase();
    const caseB = battleCase({
      caseId: "case-b",
      allyFormation: formation("UNIT_B"),
      enemyFormation: formation("UNIT_A", "UNIT_A"),
      runIndices: [3, 1],
    });

    const together = runsByKey(evaluate(command({ cases: [caseA, caseB] })));
    const reversed = runsByKey(evaluate(command({ cases: [caseB, caseA] })));
    const split = new Map([
      ...runsByKey(evaluate(command({ cases: [{ ...caseA, runIndices: [0, 2] }] }))),
      ...runsByKey(evaluate(command({ cases: [{ ...caseA, runIndices: [3, 1] }] }))),
      ...runsByKey(evaluate(command({ cases: [caseB] }))),
    ]);

    expect(reversed).toEqual(together);
    expect(split).toEqual(together);
  });

  it("UT-BEVAL-003: each run matches the single battle use case given the same seeded random source", () => {
    const caseInput = battleCase({ runIndices: [0, 42] });
    const result = evaluate(command({ cases: [caseInput] }));

    for (const run of result.cases[0]!.runs) {
      const single = new SimulateBattleUseCase({
        battleCatalog: battleCatalog(),
        battleIdGenerator: new FixedBattleIdGenerator(["B_SINGLE"]),
        clock: new ManualClock(0),
        randomSourceFactory: new Mulberry32SeededRandomSourceProvider().forRun(SEED, run.runIndex),
      }).execute(
        {
          allyFormation: caseInput.allyFormation,
          enemyFormation: caseInput.enemyFormation,
          turnLimit: caseInput.turnLimit,
          logLevel: "SUMMARY",
        },
        CONTEXT,
      );

      expect(run.result.outcome).toBe(single.outcome);
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

  it("UT-BEVAL-004: two slots holding the same unit stay distinguishable by side and unit index", () => {
    const run = evaluate(command()).cases[0]!.runs[0]!.result;

    expect(
      run.units.map(({ side, unitIndex, unitDefinitionId }) => [side, unitIndex, unitDefinitionId]),
    ).toEqual([
      ["ALLY", 0, "UNIT_A"],
      ["ALLY", 1, "UNIT_A"],
      ["ENEMY", 0, "UNIT_B"],
    ]);
    expect(["ALLY_WIN", "ALLY_LOSE"]).toContain(run.outcome);
  });

  it("UT-BEVAL-005: the result carries the seed, derivation version, catalog and engine revisions", () => {
    const catalog = battleCatalog();
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

  it("UT-BEVAL-006: an invalid turn limit in a later case rejects the request with the case index in the path", () => {
    const error = captureApplicationError(() =>
      evaluate(command({ cases: [battleCase(), battleCase({ caseId: "b", turnLimit: 0 })] })),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations.map((violation) => violation.path)).toEqual(["cases[1].turnLimit"]);
  });

  it("UT-BEVAL-007: an unknown unit in any case rejects the whole request before a single run", () => {
    const idGenerator = new FixedBattleIdGenerator([]);
    const error = captureApplicationError(() =>
      evaluate(
        command({
          cases: [
            battleCase(),
            battleCase({ caseId: "b", enemyFormation: formation("UNIT_A", "UNIT_MISSING") }),
          ],
        }),
        { ...dependencies(), battleIdGenerator: idGenerator },
      ),
    );

    // 1試行でも始めていればBattleIdの払い出しで失敗するため、到達しないことを示す。
    expect(error.code).toBe("DEFINITION_NOT_FOUND");
    expect(error.violations.map((violation) => violation.path)).toEqual([
      "cases[1].enemyFormation.slots[1].unitDefinitionId",
    ]);
  });

  it("UT-BEVAL-008: an expected revision that does not match rejects the request before a single run", () => {
    const error = captureApplicationError(() =>
      evaluate(
        command({ expectedCatalogRevision: "other", expectedEngineRevision: ENGINE_REVISION }),
        { ...dependencies(), battleIdGenerator: new FixedBattleIdGenerator([]) },
      ),
    );

    expect(error.code).toBe("INVALID_COMMAND");
    expect(error.violations.map((violation) => violation.path)).toEqual([
      "expectedCatalogRevision",
    ]);
  });

  it("UT-BEVAL-009: a deadline reached mid-request returns only completed runs and lists the rest by run index", () => {
    const clock = new ManualClock(0);
    const advancingClock: Clock = {
      now: () => {
        clock.advance(1);
        return clock.now();
      },
    };
    const caseA = battleCase({ runIndices: [0, 5, 9] });
    const caseB = battleCase({ caseId: "case-b", runIndices: [2, 4, 6] });

    const partial = evaluate(
      command({ cases: [caseA, caseB] }),
      dependencies(battleCatalog(), advancingClock),
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
      expect(
        [
          ...caseOutcome.runs.map((run) => run.runIndex),
          ...caseOutcome.incompleteRunIndices,
        ].sort(),
      ).toEqual([...requested].sort());
    }
    // 完了した試行は、期限なしで実行したときの同じ試行と一致する。
    for (const [key, value] of runsByKey(partial)) {
      expect(value).toEqual(full.get(key));
    }
  });
});
