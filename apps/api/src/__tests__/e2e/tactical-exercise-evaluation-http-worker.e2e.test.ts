import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../../infrastructure/worker/simulation-worker-pool.js";
import type { EvaluationLimits } from "../../application/simulation/evaluate-tactical-exercise-candidates-command.js";
import type { TacticalExerciseEvaluationResponseBody } from "../../application/contracts/response.js";
import type { ErrorResponseBody } from "../../application/contracts/error.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * `POST /api/v1/tactical-exercise-evaluations` の縦切りEnd-to-End。
 *
 * task runnerの単体テストは同期呼び出しで、ルートのHTTPテストはWorkerを通らない偽の
 * portで動くため、**実スレッド境界だけが壊し得るもの**——新タスク／新結果の構造化
 * クローン、`workerData`で配る評価上限、Pool経路のモード判別——はこの層でしか観測
 * できない。`tactical-exercise-http-worker.e2e.test.ts`と同じ理由で`buildServer`・
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
const PATH = "/api/v1/tactical-exercise-evaluations";

const ALLY_FORMATION = {
  units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};
const ENEMY_FORMATION = {
  units: [{ unitDefinitionId: "UNIT_002", position: { column: 0, row: "FRONT" } }],
  memoryDefinitionIds: [],
};

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

  async function startServer(evaluationLimits?: EvaluationLimits): Promise<FastifyInstance> {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
      ...(evaluationLimits !== undefined ? { evaluationLimits } : {}),
    });
    app = await buildServer(pool, { evaluationUseCase: pool });
    return app;
  }

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  it("E2E-EVAL-001: a real HTTP POST runs every candidate through an actual Worker Thread and returns the raw per-run values", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: {
        enemyFormation: ENEMY_FORMATION,
        candidates: [{ allyFormation: ALLY_FORMATION }, { allyFormation: ALLY_FORMATION }],
        runsPerCandidate: 3,
        seed: "e2e-eval",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<TacticalExerciseEvaluationResponseBody>();
    expect(body.catalogRevision).toBe(CATALOG_REVISION);
    expect(body.seed).toBe("e2e-eval");
    expect(body.candidates).toHaveLength(2);
    for (const candidate of body.candidates) {
      // 構造化クローンを跨いでも配列がそのまま届く（結果型がplain objectであること）。
      expect(candidate.completedRuns).toBe(3);
      expect(candidate.scores).toHaveLength(3);
      expect(candidate.breakCounts).toHaveLength(3);
      expect(candidate.completedTurns).toHaveLength(3);
      expect(candidate.completionReasons).toHaveLength(3);
      for (const reason of candidate.completionReasons) {
        expect(["TURN_LIMIT_REACHED", "ALLY_DEFEATED"]).toContain(reason);
      }
    }
    // 共通乱数法は実Worker越しでも成立する（同一編成の2候補が同じ乱数列を引く）。
    expect(body.candidates[1]?.scores).toEqual(body.candidates[0]?.scores);
  });

  it("E2E-EVAL-002: the same seed replays the same scores through the real Worker", async () => {
    const server = await startServer();
    const payload = {
      enemyFormation: ENEMY_FORMATION,
      candidates: [{ allyFormation: ALLY_FORMATION }],
      runsPerCandidate: 2,
      seed: "e2e-eval-replay",
    };

    const first = await server.inject({ method: "POST", url: PATH, payload });
    const second = await server.inject({ method: "POST", url: PATH, payload });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("E2E-EVAL-003: an omitted seed is generated inside the Worker and echoed, so the response can replay itself", async () => {
    const server = await startServer();
    const payload = {
      enemyFormation: ENEMY_FORMATION,
      candidates: [{ allyFormation: ALLY_FORMATION }],
      runsPerCandidate: 1,
    };

    const generated = await server.inject({ method: "POST", url: PATH, payload });
    const seed = generated.json<TacticalExerciseEvaluationResponseBody>().seed;
    const replayed = await server.inject({
      method: "POST",
      url: PATH,
      payload: { ...payload, seed },
    });

    expect(seed).not.toBe("");
    expect(replayed.json<TacticalExerciseEvaluationResponseBody>().candidates).toEqual(
      generated.json<TacticalExerciseEvaluationResponseBody>().candidates,
    );
  });

  it("E2E-EVAL-004: the configured evaluation limits reach the Worker through workerData and bound what a request may ask for", async () => {
    // 既定値（300）より遥かに小さい上限を配る。`workerData`で届いていなければ
    // Worker側は既定値で判定してしまい、この要求は通ってしまう。
    const server = await startServer({ maxCandidates: 1, maxTotalRuns: 2 });

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: {
        enemyFormation: ENEMY_FORMATION,
        candidates: [{ allyFormation: ALLY_FORMATION }],
        runsPerCandidate: 5,
        seed: "e2e-eval-limits",
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<ErrorResponseBody>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(body.error.violations.some((violation) => violation.message.includes("2"))).toBe(true);
  });

  it("E2E-EVAL-005 (R-TEX-11): a candidate that uses the exercise enemy as an ally is rejected with the candidate index through the real Worker", async () => {
    const server = await startServer();

    const response = await server.inject({
      method: "POST",
      url: PATH,
      payload: {
        enemyFormation: ENEMY_FORMATION,
        candidates: [
          { allyFormation: ALLY_FORMATION },
          {
            allyFormation: {
              units: [{ unitDefinitionId: "UNIT_002", position: { column: 0, row: "FRONT" } }],
              memoryDefinitionIds: [],
            },
          },
        ],
        runsPerCandidate: 1,
        seed: "e2e-eval-pool",
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<ErrorResponseBody>();
    expect(body.error.code).toBe("INVALID_COMMAND");
    expect(
      body.error.violations.some(
        (violation) => violation.ruleId === "R-TEX-11" && violation.path?.includes("candidates/1"),
      ),
    ).toBe(true);
  });
});
