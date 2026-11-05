import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../../infrastructure/worker/simulation-worker-pool.js";
import type { TotalWarResponseBody } from "../../application/contracts/response.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * `POST /api/v1/total-war-simulations`（TW-008）の縦切りEnd-to-End。総力戦の結果は
 * 戦闘履歴・全編成のroster・途中で加わるユニットの差分を持ち、Worker Threadとの境界を
 * structured cloneで越えるため、実Workerを通して形が保たれることを確かめる。
 * `battle-simulation-http-worker.e2e.test.ts`と同じ理由で`buildServer`・
 * `SimulationWorkerPool`をコンパイル済み`dist/`から揃えてimportする（src版と
 * dist版の二重ロードで`ApplicationError`のinstanceof判定が壊れるのを避けるため）。
 */
const apiPackageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tscBin = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const distPoolUrl = new URL(
  "../../../dist/infrastructure/worker/simulation-worker-pool.js",
  import.meta.url,
);
const distBuildServerUrl = new URL(
  "../../../dist/presentation/http/build-server.js",
  import.meta.url,
);

function fixturePath(...segments: string[]): string {
  return fileURLToPath(
    new URL(`../../infrastructure/catalog/__fixtures__/${segments.join("/")}`, import.meta.url),
  );
}

const CATALOG_DIR = fixturePath("runtime", "valid", "minimal");
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
const TOTAL_WAR_SIMULATIONS_PATH = "/api/v1/total-war-simulations";

const FORMATION = {
  units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};

describe("HTTP -> Worker -> UseCase -> Battle -> Response for a total war (TW-008)", () => {
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  let buildServer: typeof buildServerFn;

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: apiPackageRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distPoolUrl))).toBe(true);
    expect(existsSync(fileURLToPath(distBuildServerUrl))).toBe(true);
    const compiledPool = (await import(distPoolUrl.href)) as {
      SimulationWorkerPool: typeof SimulationWorkerPoolClass;
    };
    const compiledServer = (await import(distBuildServerUrl.href)) as {
      buildServer: typeof buildServerFn;
    };
    SimulationWorkerPool = compiledPool.SimulationWorkerPool;
    buildServer = compiledServer.buildServer;
  }, 120_000);

  let pool: SimulationWorkerPoolClass | undefined;
  let app: FastifyInstance | undefined;

  async function startServer(): Promise<FastifyInstance> {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
    });
    app = await buildServer(pool, { totalWarUseCase: pool });
    return app;
  }

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  it("E2E-TWR-001 (R-TWR-02/06): a real HTTP POST /api/v1/total-war-simulations completes through an actual Worker Thread and returns the result, the stage history and the roster of every formation", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: TOTAL_WAR_SIMULATIONS_PATH,
      payload: {
        allyFormations: [FORMATION],
        // 同じユニットを別の編成へ置く（R-TWR-01 #3は1編成内の重複だけを禁じる）。
        enemyFormations: [FORMATION, FORMATION],
        options: { logLevel: "DETAILED" },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TotalWarResponseBody>();
    expect(body.catalogRevision).toBe(CATALOG_REVISION);
    expect(["ALLY_WIN", "ALLY_LOSE", "DRAW"]).toContain(body.result.outcome);
    expect(body.result.completedTurn).toBeLessThanOrEqual(15);
    expect(body.result.stages.length).toBeGreaterThan(0);
    expect(body.result.stages[0]).toMatchObject({
      stageNumber: 1,
      allyFormationNumber: 1,
      enemyFormationNumber: 1,
      startTurn: 1,
    });
    // rosterは控えを含む全編成の全ユニット。2回目の登場は再登場補正を受ける（R-TWR-02）。
    expect(
      body.unitRoster.map(({ side, formationNumber, reappearance }) => ({
        side,
        formationNumber,
        reappearance,
      })),
    ).toEqual([
      { side: "ALLY", formationNumber: 1, reappearance: false },
      { side: "ENEMY", formationNumber: 1, reappearance: false },
      { side: "ENEMY", formationNumber: 2, reappearance: true },
    ]);
    expect(body.unitSummaries.map((summary) => summary.battleUnitId)).toEqual(
      body.unitRoster.map((entry) => entry.battleUnitId),
    );
    expect(body.initialState.formations?.enemy.formationCount).toBe(2);
  });

  it("E2E-TWR-002 (R-TWR-01 #3): rejects a unit repeated within one formation with 422 INVALID_COMMAND through the real Worker, naming the formation index", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: TOTAL_WAR_SIMULATIONS_PATH,
      payload: {
        allyFormations: [
          FORMATION,
          {
            units: [
              { unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } },
              { unitDefinitionId: "UNIT_001", position: { column: 1, row: "FRONT" } },
            ],
            memoryDefinitionIds: [],
          },
        ],
        enemyFormations: [FORMATION],
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{
      error: { code: string; violations: { path?: string; ruleId?: string }[] };
    }>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations).toContainEqual(
      expect.objectContaining({
        path: "/allyFormations/1/units/1/unitDefinitionId",
        ruleId: "R-TWR-01",
      }),
    );
  });
});
