import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_TACTICAL_EXERCISE_EVALUATION_LIMITS } from "../../application/simulation/evaluate-tactical-exercises-command.js";
import { EvaluateTacticalExercisesUseCase } from "../../application/simulation/evaluate-tactical-exercises-use-case.js";
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
 * 戦術演習の大量試行の baseline（`12_テスト戦略.md`「負荷・耐久テスト」）。
 *
 * `TACTICAL_EXERCISE_EVALUATION_MAX_TOTAL_RUNS`の既定値は「`SIMULATION_TIMEOUT_MS`の7割に収まる試行数」
 * として実測から決めた。基準は本番Cloud Runが明示する30秒（`deploy/cloud-run/service.json`）
 * であり、`SIMULATION_TIMEOUT_MS`のコード既定値（ローカル開発専用、現在50秒）ではない
 * ——このテストは意図的に本番値を固定して使う。その前提が崩れれば上限が実態と合わなく
 * なる——上限まで要求したリクエストが常に部分結果になる——ため、上限いっぱいのリクエストが
 * 期限内に完走することをここで固定する。
 *
 * 判定は**全演習敵のうち最も遅いもの**で行う。演習敵ごとに1試行あたり50〜70msの幅が
 * あり、特定の1体（IDソート順の末尾など）を選ぶと最悪ケースを外す。演習敵が追加され
 * たときも自動的に測定対象へ入る。
 */
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
// 本番Cloud Runの明示値（`deploy/cloud-run/service.json`）を意図的に固定する。
// コードの既定値（`bootstrap/config.ts`、ローカル開発専用）とは独立。
const SIMULATION_TIMEOUT_MS = 30_000;
const DEADLINE_BUDGET_RATIO = 0.7;
const PARTY_SIZE = 5;
const CASE_COUNT = 4;

describe("tactical exercise evaluation load baseline", () => {
  it("LOAD-TEXEVAL-001: a request at TACTICAL_EXERCISE_EVALUATION_MAX_TOTAL_RUNS completes every run inside the deadline budget the limit was derived from — for the slowest exercise enemy, not an arbitrary one", () => {
    const catalog = loadCatalogFromDirectory(CATALOG_DIR);
    const allyParty = allProductionUnitIds(CATALOG_DIR).slice(0, PARTY_SIZE);
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

    const runsPerCase = Math.floor(
      DEFAULT_TACTICAL_EXERCISE_EVALUATION_LIMITS.maxTotalRuns / CASE_COUNT,
    );
    const requestedRuns = CASE_COUNT * runsPerCase;
    const useCase = new EvaluateTacticalExercisesUseCase({
      battleCatalog: catalog,
      battleIdGenerator: new UuidBattleIdGenerator(),
      clock: new SystemClock(),
      seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
      runtimeInfo: { engineRevision: "load-texeval-001" },
      limits: DEFAULT_TACTICAL_EXERCISE_EVALUATION_LIMITS,
    });

    const measurements = enemyIds.map((enemyUnitDefinitionId) => {
      const startedAt = Date.now();
      const result = useCase.execute(
        {
          seed: `load-texeval-001-${enemyUnitDefinitionId}`,
          cases: Array.from({ length: CASE_COUNT }, (_, caseIndex) => ({
            caseId: `case-${caseIndex}`,
            allyFormation,
            enemyFormation: {
              slots: [
                {
                  unitDefinitionId: createUnitDefinitionId(enemyUnitDefinitionId),
                  position: { column: 0, row: "FRONT" as const },
                },
              ],
              memoryDefinitionIds: [],
            },
            // ケースごとに別の番号を割り、同じ乱数列の繰り返しで速く見えないようにする。
            runIndices: Array.from(
              { length: runsPerCase },
              (_, runIndex) => caseIndex * runsPerCase + runIndex,
            ),
          })),
        },
        {
          requestId: "load-texeval-001",
          // 期限は判定に使う予算より広く取る。予算超過を「部分結果になった」ではなく
          // 「所要時間が予算を超えた」として観測するため（部分結果だと超過幅が分からない）。
          deadlineEpochMs: startedAt + SIMULATION_TIMEOUT_MS * 4,
        },
      );
      const elapsedMs = Date.now() - startedAt;
      const { completedRuns } = result;
      return { enemyUnitDefinitionId, elapsedMs, completedRuns };
    });

    const budgetMs = SIMULATION_TIMEOUT_MS * DEADLINE_BUDGET_RATIO;
    const slowest = measurements.reduce((worst, entry) =>
      entry.elapsedMs > worst.elapsedMs ? entry : worst,
    );

    console.log(
      JSON.stringify({
        baseline: "LOAD-TEXEVAL-001",
        caseCount: CASE_COUNT,
        runsPerCase,
        requestedRuns,
        budgetMs,
        slowestEnemyUnitDefinitionId: slowest.enemyUnitDefinitionId,
        perEnemy: measurements.map((entry) => ({
          ...entry,
          msPerRun: Number((entry.elapsedMs / Math.max(entry.completedRuns, 1)).toFixed(2)),
        })),
      }),
    );

    for (const entry of measurements) {
      expect(entry.completedRuns, `${entry.enemyUnitDefinitionId} completed every run`).toBe(
        requestedRuns,
      );
    }
    // 上限の根拠そのもの: 最悪ケースでも、上限導出に使った期限の割合に収まる。
    expect(slowest.elapsedMs, `slowest enemy ${slowest.enemyUnitDefinitionId}`).toBeLessThan(
      budgetMs,
    );
  });
});
