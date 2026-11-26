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
import type { TacticalExerciseEvaluationResponseBody } from "../../application/contracts/response.js";
import type { ErrorResponseBody } from "../../application/contracts/error.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * `POST /api/v1/tactical-exercise-evaluations` の縦切りEnd-to-End。
 *
 * task runnerの単体テストは同期呼び出しで、ルートのHTTPテストはWorkerを通らない偽の
 * portで動くため、**実スレッド境界だけが壊し得るもの**——新タスク／新結果の構造化
 * クローン、`workerData`で配る識別情報と評価上限、Pool経路のモード判別——はこの層でしか
 * 観測できない。`tactical-exercise-http-worker.e2e.test.ts`と同じ理由で`buildServer`・
 * `SimulationWorkerPool`をコンパイル済み`dist/`から揃えてimportする。
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

const CATALOG_DIR = fixturePath("runtime", "valid", "exercise");
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
const ENGINE_REVISION = "engine-e2e-exercise";
const PATH = "/api/v1/tactical-exercise-evaluations";

const ALLY_FORMATION = {
  units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};
const ENEMY_FORMATION = {
  units: [{ unitDefinitionId: "UNIT_002", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};

function payload(runIndices: number[][], seed = "e2e-eval") {
  return {
    seed,
    cases: runIndices.map((indices, caseIndex) => ({
      caseId: `case-${caseIndex}`,
      allyFormation: ALLY_FORMATION,
      enemyFormation: ENEMY_FORMATION,
      runIndices: indices,
    })),
  };
}

function runsByKey(body: TacticalExerciseEvaluationResponseBody): Map<number, unknown> {
  return new Map(
    body.cases.flatMap((caseBody) =>
      caseBody.runs.map(({ runIndex, ...observation }) => [runIndex, observation]),
    ),
  );
}

describe("HTTP -> Worker -> UseCase -> Response for a tactical exercise evaluation", () => {
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
      evaluationUseCase: pool,
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

  it("E2E-TEXEVAL-001: several cases with non-contiguous run indices go through a real Worker, carry the injected revisions and replay identically", async () => {
    const server = await startServer();
    const request = payload([[0, 1, 42], [42]]);

    const first = await server.inject({ method: "POST", url: PATH, payload: request });
    const second = await server.inject({ method: "POST", url: PATH, payload: request });

    expect(first.statusCode).toBe(200);
    const body = first.json<TacticalExerciseEvaluationResponseBody>();
    expect(body).toMatchObject({
      seed: "e2e-eval",
      catalogRevision: CATALOG_REVISION,
      engineRevision: ENGINE_REVISION,
      seedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
      requestedRuns: 4,
      completedRuns: 4,
      partial: false,
    });
    expect(body.cases.map((caseBody) => caseBody.runs.map((run) => run.runIndex))).toEqual([
      [0, 1, 42],
      [42],
    ]);
    for (const run of body.cases.flatMap((caseBody) => caseBody.runs)) {
      expect(["TURN_LIMIT_REACHED", "ALLY_DEFEATED"]).toContain(run.completionReason);
      expect(run.units.map((unit) => unit.side)).toEqual(["ALLY", "ENEMY"]);
      expect(run.allyUnitBreaks).toHaveLength(1);
    }
    // 共通乱数法は実Worker越しでも成立する（同一対戦の別ケースが同じ番号で同じ乱数列を引く）。
    expect(body.cases[1]!.runs[0]).toEqual(body.cases[0]!.runs[2]);
    expect(second.json()).toEqual(first.json());
  });

  it("E2E-TEXEVAL-002: a request split across calls returns the same observation for each run index", async () => {
    const server = await startServer();

    const whole = await server.inject({
      method: "POST",
      url: PATH,
      payload: payload([[0, 1, 2, 3]]),
    });
    const head = await server.inject({ method: "POST", url: PATH, payload: payload([[0, 1]]) });
    const tail = await server.inject({ method: "POST", url: PATH, payload: payload([[3, 2]]) });

    expect([whole.statusCode, head.statusCode, tail.statusCode]).toEqual([200, 200, 200]);
    expect(
      new Map([
        ...runsByKey(head.json<TacticalExerciseEvaluationResponseBody>()),
        ...runsByKey(tail.json<TacticalExerciseEvaluationResponseBody>()),
      ]),
    ).toEqual(runsByKey(whole.json<TacticalExerciseEvaluationResponseBody>()));
  });

  it("E2E-TEXEVAL-003: the tactical exercise limits reach the Worker through workerData and a mismatched engine revision runs nothing", async () => {
    // 既定値（300）より遥かに小さい上限を配る。`workerData`で届いていなければ
    // Worker側は既定値で判定してしまい、この要求は通ってしまう。
    const server = await startServer({
      tacticalExerciseEvaluationLimits: { maxCases: 1, maxTotalRuns: 2 },
    });

    const limited = await server.inject({
      method: "POST",
      url: PATH,
      payload: payload([[0, 1, 2]]),
    });
    expect(limited.statusCode).toBe(422);
    expect(limited.json<ErrorResponseBody>().error.violations.map((v) => v.path)).toEqual([
      "/cases",
    ]);

    const mismatched = await server.inject({
      method: "POST",
      url: PATH,
      payload: { ...payload([[0]]), expectedEngineRevision: "other" },
    });
    expect(mismatched.statusCode).toBe(422);
    expect(mismatched.json<ErrorResponseBody>().error.violations.map((v) => v.path)).toEqual([
      "/expectedEngineRevision",
    ]);
  });

  it("E2E-TEXEVAL-004: a request deadline shorter than the work returns 200 with every unfinished run listed by number", async () => {
    const server = await startServer({}, 1);
    const requested = [
      Array.from({ length: 40 }, (_, index) => index * 2),
      Array.from({ length: 40 }, (_, index) => index * 2 + 1),
    ];

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: payload(requested),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TacticalExerciseEvaluationResponseBody>();
    expect(body.partial).toBe(true);
    expect(body.completedRuns).toBeLessThan(80);
    body.cases.forEach((caseBody, caseIndex) => {
      expect(
        [...caseBody.runs.map((run) => run.runIndex), ...caseBody.incompleteRunIndices].sort(
          (a, b) => a - b,
        ),
      ).toEqual(requested[caseIndex]);
    });
  });

  it("E2E-TEXEVAL-005 (R-TEX-11): a case that uses the exercise enemy as an ally is rejected with the case index through the real Worker", async () => {
    const server = await startServer();
    const request = payload([[0], [0]]);
    request.cases[1]!.allyFormation = ENEMY_FORMATION;

    const response = await server.inject({ method: "POST", url: PATH, payload: request });

    expect(response.statusCode).toBe(422);
    const body = response.json<ErrorResponseBody>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(
      body.error.violations.some(
        (violation) => violation.ruleId === "R-TEX-11" && violation.path?.startsWith("/cases/1/"),
      ),
    ).toBe(true);
  });
});
