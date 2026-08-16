import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_EVALUATION_LIMITS } from "../../application/simulation/evaluate-tactical-exercise-candidates-command.js";
import { EvaluateTacticalExerciseCandidatesUseCase } from "../../application/simulation/evaluate-tactical-exercise-candidates-use-case.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { UuidBattleIdGenerator } from "../../infrastructure/identity/uuid-battle-id-generator.js";
import { Mulberry32SeededRandomSourceProvider } from "../../infrastructure/random/seeded-random-source.js";
import { SystemClock } from "../../infrastructure/time/system-clock.js";
import {
  allExerciseEnemyProductionUnitIds,
  allProductionUnitIds,
} from "../../testing/scenario/run-production-battle.js";

/**
 * 一括評価の baseline（`12_テスト戦略.md`「負荷・耐久テスト」）。
 *
 * `EVALUATION_MAX_TOTAL_RUNS`の既定値は「`SIMULATION_TIMEOUT_MS`（30秒）の7割に
 * 収まる試行数」として実測から決めた。その前提が崩れれば上限が実態と合わなくなる
 * ——上限まで要求したリクエストが常に部分結果になる——ため、最大サイズの
 * リクエストが期限内に完走することをここで固定し、1試行あたりの実測値を出力する。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const SIMULATION_TIMEOUT_MS = 30_000;
const DEADLINE_BUDGET_RATIO = 0.7;
const PARTY_SIZE = 5;
const CANDIDATE_COUNT = 4;

describe("tactical exercise evaluation load baseline", () => {
  it("LOAD-EVAL-001: a request at EVALUATION_MAX_TOTAL_RUNS completes every run inside the deadline budget the limit was derived from, and reports a per-run baseline", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const allyParty = allProductionUnitIds(CATALOG_DIR).slice(0, PARTY_SIZE);
    // 最も遅い敵で上限を決めているため、baseline も演習敵をひととおり跨いで測る。
    const enemyIds = allExerciseEnemyProductionUnitIds(CATALOG_DIR);
    expect(enemyIds.length).toBeGreaterThan(0);

    const columns = [0, 1, 2] as const;
    const allyFormation = {
      slots: allyParty.map((unitDefinitionId, index) => ({
        unitDefinitionId: createUnitDefinitionId(unitDefinitionId),
        position: {
          column: columns[index % 3]!,
          row: index < 3 ? ("FRONT" as const) : ("REAR" as const),
        },
      })),
      memoryDefinitionIds: [],
    };

    const runsPerCandidate = Math.floor(DEFAULT_EVALUATION_LIMITS.maxTotalRuns / CANDIDATE_COUNT);
    const useCase = new EvaluateTacticalExerciseCandidatesUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new UuidBattleIdGenerator(),
      clock: new SystemClock(),
      seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
      limits: DEFAULT_EVALUATION_LIMITS,
    });

    const slowestEnemyId = enemyIds[enemyIds.length - 1]!;
    const startedAt = Date.now();
    const result = useCase.execute(
      {
        enemyFormation: {
          slots: [
            {
              unitDefinitionId: createUnitDefinitionId(slowestEnemyId),
              position: { column: 0, row: "FRONT" },
            },
          ],
          memoryDefinitionIds: [],
        },
        candidates: Array.from({ length: CANDIDATE_COUNT }, () => ({ allyFormation })),
        runsPerCandidate,
        seed: "load-eval-001",
      },
      {
        requestId: "load-eval-001",
        deadlineEpochMs: startedAt + SIMULATION_TIMEOUT_MS,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    const completedRuns = result.candidates.reduce(
      (total, candidate) => total + candidate.completedRuns,
      0,
    );
    const requestedRuns = CANDIDATE_COUNT * runsPerCandidate;

    console.log(
      JSON.stringify({
        baseline: "LOAD-EVAL-001",
        enemyUnitDefinitionId: slowestEnemyId,
        candidateCount: CANDIDATE_COUNT,
        runsPerCandidate,
        requestedRuns,
        completedRuns,
        elapsedMs,
        msPerRun: Number((elapsedMs / Math.max(completedRuns, 1)).toFixed(2)),
      }),
    );

    // 上限の根拠そのもの: 上限いっぱいの要求が、期限のうち上限導出に使った割合で完走する。
    expect(completedRuns).toBe(requestedRuns);
    expect(elapsedMs).toBeLessThan(SIMULATION_TIMEOUT_MS * DEADLINE_BUDGET_RATIO);
  });
});
