import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkerSimulationTask } from "../../infrastructure/worker/worker-contract.js";
import { createSimulationTaskRunner } from "../../infrastructure/worker/simulation-task-runner.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { FixedBattleIdGenerator } from "../../testing/id/fixed-battle-id-generator.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";
import { SequenceRandomSourceFactory } from "../../testing/random/sequence-random-source-factory.js";
import {
  allExerciseEnemyProductionUnitIds,
  allProductionUnitIds,
} from "../../testing/scenario/run-production-battle.js";

/**
 * 単発APIの再生（`10_API設計.md`「SimulationReplay」）が、実Catalog・実エンジン上で
 * 大量試行の完了試行を再現することの確認層。
 *
 * 大量試行は`SUMMARY`、再生は`DETAILED`で実行する。ログの水準が乱数の消費順を変えると
 * 再生は別の戦闘になるが、最小fixtureでは乱数が結果をほとんど左右しないため気づけない。
 * 散る乱数列で複数の試行番号を流し、試行番号ごとに結果が実際に異なることも併せて
 * 要求して、一致が空振りしていないことを担保する。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const catalog = loadCatalogFromDirectory(CATALOG_DIR);
const ENGINE_REVISION = "engine-replay";
const SEED = "issue-898";
const RUN_INDICES = [0, 1, 2, 3];

const PLAYABLE = allProductionUnitIds(CATALOG_DIR);
const EXERCISE_ENEMY = allExerciseEnemyProductionUnitIds(CATALOG_DIR)[0]!;

function formation(unitIds: readonly string[]) {
  return {
    units: unitIds.map((unitDefinitionId, column) => ({
      unitDefinitionId,
      position: { column: column % 3, row: column < 3 ? "FRONT" : "REAR" },
    })),
    memoryDefinitionIds: [],
  };
}

const ALLY = formation(PLAYABLE.slice(0, 5));
const ENEMY = formation(PLAYABLE.slice(5, 10));
const ALLY_RESERVE = formation(PLAYABLE.slice(10, 15));

const runner = createSimulationTaskRunner(catalog, {
  battleIdGenerator: new FixedBattleIdGenerator(
    Array.from({ length: 64 }, (_, index) => `B_${index}`),
  ),
  randomSourceFactory: new SequenceRandomSourceFactory([]),
  clock: new ManualClock(Date.now()),
  engineRevision: ENGINE_REVISION,
});

function run(
  task: Omit<WorkerSimulationTask, "requestId" | "deadlineEpochMs" | "expectedCatalogRevision">,
) {
  const outcome = runner({
    ...task,
    requestId: "req-replay-golden",
    deadlineEpochMs: Date.now() + 600_000,
    expectedCatalogRevision: catalog.catalogRevision,
  } as WorkerSimulationTask);
  if (!outcome.ok) {
    expect.fail(`expected an ok outcome, got ${JSON.stringify(outcome.error)}`);
  }
  return outcome;
}

function replayOf(runIndex: number) {
  return {
    seed: SEED,
    runIndex,
    expectedCatalogRevision: catalog.catalogRevision,
    expectedEngineRevision: ENGINE_REVISION,
    expectedSeedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
  };
}

/** 枠の対応は形式ごとに既存テストが固定済みなので、ここでは集計値の多重集合で比べる。 */
function unitTotals(
  units: readonly { damageDealt: number; damageTaken: number; finalHp: number }[],
): string[] {
  return units.map((unit) => `${unit.damageDealt}/${unit.damageTaken}/${unit.finalHp}`).sort();
}

describe("seeded replay reproduces evaluated runs on the production catalog", () => {
  it("E2E-SEEDDET-003: a normal battle replay matches the evaluated outcome, reason, turn and unit totals for every run", () => {
    const evaluated = run({
      mode: "BATTLE_EVALUATION",
      request: {
        seed: SEED,
        cases: [
          {
            caseId: "c",
            allyFormation: ALLY,
            enemyFormation: ENEMY,
            turnLimit: 10,
            runIndices: RUN_INDICES,
          },
        ],
      },
    });
    if (evaluated.mode !== "BATTLE_EVALUATION") expect.fail("unexpected mode");

    const observed = evaluated.result.cases[0]!.runs.map(({ runIndex, result: saved }) => {
      const replayed = run({
        mode: "BATTLE_SIMULATION",
        request: {
          allyFormation: ALLY,
          enemyFormation: ENEMY,
          turnLimit: 10,
          replay: replayOf(runIndex),
        },
      });
      if (replayed.mode !== "BATTLE_SIMULATION") expect.fail("unexpected mode");
      const actual = replayed.result;
      expect(actual.events.length).toBeGreaterThan(0);
      expect({
        outcome: actual.outcome,
        completionReason: actual.completionReason,
        completedTurn: actual.completedTurn,
        units: unitTotals(actual.unitSummaries),
      }).toEqual({
        outcome: saved.outcome,
        completionReason: saved.completionReason,
        completedTurn: saved.completedTurn,
        units: unitTotals(saved.units),
      });
      return JSON.stringify(unitTotals(saved.units));
    });

    expect(observed).toHaveLength(RUN_INDICES.length);
    expect(new Set(observed).size).toBeGreaterThan(1);
  });

  it("E2E-SEEDDET-004: a tactical exercise replay matches the evaluated score, breaks, reason, turn and unit totals for every run", () => {
    const enemyFormation = formation([EXERCISE_ENEMY]);
    const evaluated = run({
      mode: "TACTICAL_EXERCISE_EVALUATION",
      request: {
        seed: SEED,
        cases: [{ caseId: "c", allyFormation: ALLY, enemyFormation, runIndices: RUN_INDICES }],
      },
    });
    if (evaluated.mode !== "TACTICAL_EXERCISE_EVALUATION") expect.fail("unexpected mode");

    const observed = evaluated.result.cases[0]!.runs.map(({ runIndex, result: saved }) => {
      const replayed = run({
        mode: "TACTICAL_EXERCISE",
        request: { allyFormation: ALLY, enemyFormation, replay: replayOf(runIndex) },
      });
      if (replayed.mode !== "TACTICAL_EXERCISE") expect.fail("unexpected mode");
      const actual = replayed.result;
      expect(actual.events.length).toBeGreaterThan(0);
      expect({
        totalScore: actual.totalScore,
        breakCount: actual.breakCount,
        completionReason: actual.completionReason,
        completedTurn: actual.completedTurn,
        units: unitTotals(actual.unitSummaries),
      }).toEqual({
        totalScore: saved.totalScore,
        breakCount: saved.breakCount,
        completionReason: saved.completionReason,
        completedTurn: saved.completedTurn,
        units: unitTotals(saved.units),
      });
      return saved.totalScore;
    });

    expect(new Set(observed).size).toBeGreaterThan(1);
  });

  it("E2E-SEEDDET-005: a total war replay matches the evaluated outcome, reason, turn, stages, defeated formation counts and unit totals for every run", () => {
    const formations = { allyFormations: [ALLY, ALLY_RESERVE], enemyFormations: [ENEMY] };
    const evaluated = run({
      mode: "TOTAL_WAR_EVALUATION",
      request: { seed: SEED, cases: [{ caseId: "c", ...formations, runIndices: RUN_INDICES }] },
    });
    if (evaluated.mode !== "TOTAL_WAR_EVALUATION") expect.fail("unexpected mode");

    const observed = evaluated.result.cases[0]!.runs.map(({ runIndex, result: saved }) => {
      const replayed = run({
        mode: "TOTAL_WAR",
        request: { ...formations, replay: replayOf(runIndex) },
      });
      if (replayed.mode !== "TOTAL_WAR") expect.fail("unexpected mode");
      const actual = replayed.result;
      expect(actual.events.length).toBeGreaterThan(0);
      expect({
        outcome: actual.outcome,
        completionReason: actual.completionReason,
        completedTurn: actual.completedTurn,
        stages: actual.stages,
        defeatedFormationCounts: actual.defeatedFormationCounts,
        units: unitTotals(actual.unitSummaries),
      }).toEqual({
        outcome: saved.outcome,
        completionReason: saved.completionReason,
        completedTurn: saved.completedTurn,
        stages: saved.stages,
        defeatedFormationCounts: saved.defeatedFormationCounts,
        units: unitTotals(saved.units),
      });
      return JSON.stringify(unitTotals(saved.units));
    });

    expect(new Set(observed).size).toBeGreaterThan(1);
  });
});
