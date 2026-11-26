import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type {
  SimulationWorkerPool as SimulationWorkerPoolClass,
  SimulationWorkerPoolOptions,
} from "../../infrastructure/worker/simulation-worker-pool.js";
import type {
  BattleEvaluationResponseBody,
  TotalWarEvaluationResponseBody,
} from "../../application/contracts/response.js";
import type { ErrorResponseBody } from "../../application/contracts/error.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * `POST /api/v1/battle-evaluations`・`POST /api/v1/total-war-evaluations`の縦切りEnd-to-End。
 *
 * 新しいタスク・結果の構造化クローン、`workerData`で配る識別情報と形式別の上限、Pool経路の
 * モード判別は実スレッド境界でしか壊れないため、この層で確かめる。演習の大量試行と同じく
 * `buildServer`・`SimulationWorkerPool`をコンパイル済み`dist/`から揃えてimportする。
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

const CATALOG_DIR = fileURLToPath(
  new URL("../../infrastructure/catalog/__fixtures__/runtime/valid/minimal", import.meta.url),
);
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
const ENGINE_REVISION = "engine-e2e";
const BATTLE_PATH = "/api/v1/battle-evaluations";
const TOTAL_WAR_PATH = "/api/v1/total-war-evaluations";

function formation(unitCount: number) {
  return {
    units: Array.from({ length: unitCount }, (_, column) => ({
      unitDefinitionId: "UNIT_001",
      position: { column, row: "FRONT" },
    })),
    memoryDefinitionIds: [],
  };
}

describe("HTTP -> Worker -> UseCase -> Response for seeded evaluations", () => {
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  let buildServer: typeof buildServerFn;

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: apiPackageRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distPoolUrl))).toBe(true);
    expect(existsSync(fileURLToPath(distBuildServerUrl))).toBe(true);
    SimulationWorkerPool = (
      (await import(distPoolUrl.href)) as { SimulationWorkerPool: typeof SimulationWorkerPoolClass }
    ).SimulationWorkerPool;
    buildServer = ((await import(distBuildServerUrl.href)) as { buildServer: typeof buildServerFn })
      .buildServer;
  }, 120_000);

  let pool: SimulationWorkerPoolClass | undefined;
  let app: FastifyInstance | undefined;

  async function startServer(
    poolOptions: Partial<SimulationWorkerPoolOptions> = {},
    simulationTimeoutMs?: number,
  ): Promise<FastifyInstance> {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
      engineRevision: ENGINE_REVISION,
      ...poolOptions,
    });
    app = await buildServer(pool, {
      battleEvaluationUseCase: pool,
      totalWarEvaluationUseCase: pool,
      ...(simulationTimeoutMs !== undefined ? { simulationTimeoutMs } : {}),
    });
    return app;
  }

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  function battlePayload(runIndices: number[][]) {
    return {
      seed: "e2e-battle",
      expectedCatalogRevision: CATALOG_REVISION,
      expectedEngineRevision: ENGINE_REVISION,
      cases: runIndices.map((indices, caseIndex) => ({
        caseId: `case-${caseIndex}`,
        allyFormation: formation(caseIndex + 1),
        enemyFormation: formation(1),
        turnLimit: 5,
        runIndices: indices,
      })),
    };
  }

  it("E2E-BEVAL-001: several cases and runs go through a real Worker, carry the injected revisions and replay identically", async () => {
    const server = await startServer();
    const payload = battlePayload([
      [0, 1, 42],
      [7, 3],
    ]);

    const first = await server.inject({ method: "POST", url: BATTLE_PATH, payload });
    const second = await server.inject({ method: "POST", url: BATTLE_PATH, payload });

    expect(first.statusCode).toBe(200);
    const body = first.json<BattleEvaluationResponseBody>();
    expect(body).toMatchObject({
      seed: "e2e-battle",
      catalogRevision: CATALOG_REVISION,
      engineRevision: ENGINE_REVISION,
      seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
      requestedRuns: 5,
      completedRuns: 5,
      partial: false,
    });
    expect(body.cases.map((caseBody) => caseBody.runs.map((run) => run.runIndex))).toEqual([
      [0, 1, 42],
      [7, 3],
    ]);
    expect(body.cases[1]!.runs[0]!.units.filter((unit) => unit.side === "ALLY")).toHaveLength(2);
    expect(second.json()).toEqual(body);
  });

  it("E2E-BEVAL-002: a request split across calls returns the same result for each run", async () => {
    const server = await startServer();

    const together = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battlePayload([[0, 1, 42]]),
    });
    const tail = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battlePayload([[42]]),
    });

    expect(together.statusCode).toBe(200);
    expect(tail.statusCode).toBe(200);
    expect(tail.json<BattleEvaluationResponseBody>().cases[0]!.runs[0]).toEqual(
      together.json<BattleEvaluationResponseBody>().cases[0]!.runs[2],
    );
  });

  it("E2E-BEVAL-003: the battle limits reach the Worker through workerData and a mismatched engine revision runs nothing", async () => {
    const server = await startServer({ battleEvaluationLimits: { maxCases: 1, maxTotalRuns: 2 } });

    const overLimit = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battlePayload([[0, 1, 2]]),
    });
    const mismatch = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: { ...battlePayload([[0]]), expectedEngineRevision: "other-engine" },
    });

    expect(overLimit.statusCode).toBe(422);
    expect(overLimit.json<ErrorResponseBody>().error.violations.map((v) => v.path)).toEqual([
      "/cases",
    ]);
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json<ErrorResponseBody>().error.violations.map((v) => v.path)).toEqual([
      "/expectedEngineRevision",
    ]);
  });

  it("E2E-BEVAL-004: a request deadline shorter than the work returns 200 with every unfinished run listed by number", async () => {
    const server = await startServer({}, 1);
    const requested = [
      Array.from({ length: 30 }, (_, index) => index * 2),
      Array.from({ length: 30 }, (_, index) => index * 2 + 1),
    ];

    const response = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battlePayload(requested),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<BattleEvaluationResponseBody>();
    expect(body.partial).toBe(true);
    expect(body.completedRuns).toBeLessThan(60);
    body.cases.forEach((caseBody, caseIndex) => {
      expect(
        [...caseBody.runs.map((run) => run.runIndex), ...caseBody.incompleteRunIndices].sort(
          (a, b) => a - b,
        ),
      ).toEqual(requested[caseIndex]);
    });
  });

  it("E2E-TWEVAL-001: total war cases run as whole wars through a real Worker with stages and every slot", async () => {
    const server = await startServer();
    const payload = {
      seed: "e2e-total-war",
      cases: [
        {
          caseId: "war-a",
          allyFormations: [formation(1), formation(1)],
          enemyFormations: [formation(1)],
          runIndices: [0, 5],
        },
        {
          caseId: "war-b",
          allyFormations: [formation(1)],
          enemyFormations: [formation(1), formation(1), formation(1)],
          runIndices: [2],
        },
      ],
    };

    const first = await server.inject({ method: "POST", url: TOTAL_WAR_PATH, payload });
    const second = await server.inject({ method: "POST", url: TOTAL_WAR_PATH, payload });

    expect(first.statusCode).toBe(200);
    const body = first.json<TotalWarEvaluationResponseBody>();
    expect(body).toMatchObject({
      engineRevision: ENGINE_REVISION,
      requestedRuns: 3,
      completedRuns: 3,
    });
    for (const caseBody of body.cases) {
      for (const run of caseBody.runs) {
        expect(["ALLY_WIN", "ALLY_LOSE", "DRAW"]).toContain(run.outcome);
        expect(run.stages.length).toBeGreaterThan(0);
      }
    }
    const warB = body.cases[1]!.runs[0]!;
    expect(warB.units.map((unit) => [unit.side, unit.formationNumber, unit.reappearance])).toEqual([
      ["ALLY", 1, false],
      ["ENEMY", 1, false],
      ["ENEMY", 2, true],
      ["ENEMY", 3, true],
    ]);
    expect(second.json()).toEqual(body);
  });

  it("E2E-TWEVAL-002: the total war limits reach the Worker separately from the battle limits", async () => {
    const server = await startServer({
      totalWarEvaluationLimits: { maxCases: 1, maxTotalRuns: 1 },
    });

    const response = await server.inject({
      method: "POST",
      url: TOTAL_WAR_PATH,
      payload: {
        seed: "e2e-total-war-limit",
        cases: [
          {
            caseId: "war",
            allyFormations: [formation(1)],
            enemyFormations: [formation(1)],
            runIndices: [0, 1],
          },
        ],
      },
    });
    const battle = await server.inject({
      method: "POST",
      url: BATTLE_PATH,
      payload: battlePayload([[0, 1]]),
    });

    expect(response.statusCode).toBe(422);
    expect(battle.statusCode).toBe(200);
  });
});
