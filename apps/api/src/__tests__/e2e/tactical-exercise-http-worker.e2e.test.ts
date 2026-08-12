import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../../infrastructure/worker/simulation-worker-pool.js";
import type { TacticalExerciseResponseBody } from "../../application/contracts/response.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * `POST /api/v1/tactical-exercises`（TEX-007）の縦切りEnd-to-End。
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

// R-TEX-11: 演習の敵はEXERCISE_ENEMYユニットでなければならないため、
// PLAYABLE 1体だけのminimalではなくUNIT_002（EXERCISE_ENEMY）入りのfixtureを使う。
const CATALOG_DIR = fixturePath("runtime", "valid", "exercise");
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
const TACTICAL_EXERCISES_PATH = "/api/v1/tactical-exercises";

const ALLY_FORMATION = {
  units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};
const ENEMY_FORMATION = {
  units: [{ unitDefinitionId: "UNIT_002", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};

describe("HTTP -> Worker -> UseCase -> Battle -> Response for a tactical exercise (TEX-007)", () => {
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
    app = await buildServer(pool, { exerciseUseCase: pool });
    return app;
  }

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  it("E2E-TEX-001 (R-TEX-02/09/10): a real HTTP POST /api/v1/tactical-exercises completes the fixed 5 turns through an actual Worker Thread and returns the accumulated score plus the break history, without an outcome", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: { allyFormation: ALLY_FORMATION, enemyFormation: ENEMY_FORMATION },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TacticalExerciseResponseBody>();
    expect(body.catalogRevision).toBe(CATALOG_REVISION);
    expect(body.result).not.toHaveProperty("outcome");
    expect(["TURN_LIMIT_REACHED", "ALLY_DEFEATED"]).toContain(body.result.completionReason);
    expect(body.result.completedTurn).toBeLessThanOrEqual(5);
    // 味方が敵へダメージを与えられる最小Catalogなので、スコアは必ず積み上がる（R-TEX-02）。
    expect(body.result.totalScore).toBeGreaterThan(0);
    // ブレイク履歴は件数が`breakCount`と一致し、番号は1から連番になる（R-TEX-10 #2）。
    expect(body.result.breaks).toHaveLength(body.result.breakCount);
    expect(body.result.breaks.map((entry) => entry.breakNumber)).toEqual(
      body.result.breaks.map((_, index) => index + 1),
    );
    for (const entry of body.result.breaks) {
      expect(entry.cumulativeScoreAtBreak).toBeLessThanOrEqual(body.result.totalScore);
      expect(entry.turnNumber).toBeLessThanOrEqual(body.result.completedTurn);
    }
    // 累計スコアの差分は演習だけが持つ（R-TEX-02 #4）。
    expect(body.stateTransitions.some((transition) => transition.delta.exercise?.totalScore)).toBe(
      true,
    );
  });

  it("E2E-TEX-002 (R-TEX-01 #3): rejects an enemy formation of two units with 422 INVALID_COMMAND through the real Worker", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: {
        allyFormation: ALLY_FORMATION,
        enemyFormation: {
          units: [
            { unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } },
            { unitDefinitionId: "UNIT_001", position: { column: 1, row: "FRONT" } },
          ],
          memoryDefinitionIds: [],
        },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; violations: { path?: string }[] } }>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations.map((violation) => violation.path)).toContain(
      "/enemyFormation/units",
    );
  });

  it("E2E-TEX-003 (R-TEX-01 #3): rejects an enemy formation carrying a memory with 422 INVALID_COMMAND", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: {
        allyFormation: ALLY_FORMATION,
        enemyFormation: { ...ENEMY_FORMATION, memoryDefinitionIds: ["MEM_001"] },
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; violations: { path?: string }[] } }>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations.map((violation) => violation.path)).toContain(
      "/enemyFormation/memoryDefinitionIds",
    );
  });

  it("E2E-TEX-004 (10_API設計.md「TacticalExerciseRequest」): rejects a turnLimit outright (400 MALFORMED_REQUEST) instead of running the fixed 5 turns as if it had been honoured", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: TACTICAL_EXERCISES_PATH,
      payload: {
        allyFormation: ALLY_FORMATION,
        enemyFormation: ENEMY_FORMATION,
        turnLimit: 3,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("MALFORMED_REQUEST");
  });
});
