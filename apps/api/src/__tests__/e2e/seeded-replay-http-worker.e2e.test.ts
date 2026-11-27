import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../../infrastructure/worker/simulation-worker-pool.js";
import type {
  BattleEvaluationResponseBody,
  BattleSimulationResponseBody,
  TacticalExerciseEvaluationResponseBody,
  TacticalExerciseResponseBody,
  TotalWarEvaluationResponseBody,
  TotalWarResponseBody,
} from "../../application/contracts/response.js";
import type { ErrorResponseBody } from "../../application/contracts/error.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * 単発APIの再生（`10_API設計.md`「SimulationReplay」）の縦切りEnd-to-End。
 *
 * 大量試行APIの応答から試行と識別情報を取り、同じ条件を同形式の単発APIへ渡して、
 * 実Worker越しに同じ結果と詳細ログが返ることを3形式で確かめる。再生指定は単発タスクの
 * 本文に載ってWorkerへ構造化クローンされるため、この経路は実スレッド境界でしか壊れない。
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

// R-TEX-11: 演習の敵（UNIT_002）を含むfixture。通常戦闘・総力戦はUNIT_001だけで組む。
const CATALOG_DIR = fileURLToPath(
  new URL("../../infrastructure/catalog/__fixtures__/runtime/valid/exercise", import.meta.url),
);
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
const ENGINE_REVISION = "engine-replay-e2e";
const SEED = "e2e-replay";
const RUN_INDICES = [0, 5, 42];

function formation(unitDefinitionId: string, unitCount = 1) {
  return {
    units: Array.from({ length: unitCount }, (_, column) => ({
      unitDefinitionId,
      position: { column, row: "FRONT" },
    })),
    memoryDefinitionIds: [],
  };
}

describe("HTTP -> Worker -> UseCase -> Response for single-run replays", () => {
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

  async function startServer(replayEnabled = true): Promise<FastifyInstance> {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
      engineRevision: ENGINE_REVISION,
    });
    app = await buildServer(pool, {
      exerciseUseCase: pool,
      totalWarUseCase: pool,
      replayEnabled,
      ...(replayEnabled
        ? {
            evaluationUseCase: pool,
            battleEvaluationUseCase: pool,
            totalWarEvaluationUseCase: pool,
          }
        : {}),
    });
    return app;
  }

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  /** 評価応答に記録された識別情報から再生指定を組み立てる。 */
  function replayFrom(
    header: {
      seed: string;
      catalogRevision: string;
      engineRevision: string;
      seedDerivationVersion: string;
    },
    runIndex: number,
  ) {
    return {
      seed: header.seed,
      runIndex,
      expectedCatalogRevision: header.catalogRevision,
      expectedEngineRevision: header.engineRevision,
      expectedSeedDerivationVersion: header.seedDerivationVersion,
    };
  }

  it("E2E-REPLAY-001: each completed normal battle run is reproduced by the battle POST with its detailed log", async () => {
    const server = await startServer();
    const match = {
      allyFormation: formation("UNIT_001", 2),
      enemyFormation: formation("UNIT_001"),
      turnLimit: 5,
    };
    const evaluation = await server.inject({
      method: "POST",
      url: "/api/v1/battle-evaluations",
      payload: { seed: SEED, cases: [{ caseId: "c", ...match, runIndices: RUN_INDICES }] },
    });
    expect(evaluation.statusCode).toBe(200);
    const evaluated = evaluation.json<BattleEvaluationResponseBody>();

    for (const run of evaluated.cases[0]!.runs) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: { ...match, replay: replayFrom(evaluated, run.runIndex) },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<BattleSimulationResponseBody>();
      expect(body.catalogRevision).toBe(evaluated.catalogRevision);
      expect(body.result).toEqual({
        outcome: run.outcome,
        completionReason: run.completionReason,
        completedTurn: run.completedTurn,
      });
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.stateTransitions.length).toBeGreaterThan(0);
    }
  });

  it("E2E-REPLAY-002: each completed tactical exercise run is reproduced by the exercise POST with its detailed log", async () => {
    const server = await startServer();
    const match = {
      allyFormation: formation("UNIT_001", 2),
      enemyFormation: formation("UNIT_002"),
    };
    const evaluation = await server.inject({
      method: "POST",
      url: "/api/v1/tactical-exercise-evaluations",
      payload: { seed: SEED, cases: [{ caseId: "c", ...match, runIndices: RUN_INDICES }] },
    });
    expect(evaluation.statusCode).toBe(200);
    const evaluated = evaluation.json<TacticalExerciseEvaluationResponseBody>();

    for (const run of evaluated.cases[0]!.runs) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/tactical-exercises",
        payload: {
          ...match,
          options: { logLevel: "DETAILED" },
          replay: replayFrom(evaluated, run.runIndex),
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<TacticalExerciseResponseBody>();
      expect(body.result).toMatchObject({
        totalScore: run.totalScore,
        breakCount: run.breakCount,
        completionReason: run.completionReason,
        completedTurn: run.completedTurn,
      });
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.stateTransitions.length).toBeGreaterThan(0);
    }
  });

  it("E2E-REPLAY-003: each completed total war run is reproduced by the total war POST with stages and defeated formation counts", async () => {
    const server = await startServer();
    const match = {
      // R-TWR-01 #3: 同じユニットは1編成に1体まで。
      allyFormations: [formation("UNIT_001"), formation("UNIT_001")],
      enemyFormations: [formation("UNIT_001")],
    };
    const evaluation = await server.inject({
      method: "POST",
      url: "/api/v1/total-war-evaluations",
      payload: { seed: SEED, cases: [{ caseId: "c", ...match, runIndices: RUN_INDICES }] },
    });
    expect(evaluation.statusCode).toBe(200);
    const evaluated = evaluation.json<TotalWarEvaluationResponseBody>();

    for (const run of evaluated.cases[0]!.runs) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/total-war-simulations",
        payload: { ...match, replay: replayFrom(evaluated, run.runIndex) },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<TotalWarResponseBody>();
      expect(body.result).toEqual({
        outcome: run.outcome,
        completionReason: run.completionReason,
        completedTurn: run.completedTurn,
        stages: run.stages,
        defeatedFormationCounts: run.defeatedFormationCounts,
      });
      expect(body.events.length).toBeGreaterThan(0);
    }
  });

  it("E2E-REPLAY-004: the worker rejects each mismatched identity, an out-of-range run number and an explicit SUMMARY with 422 at the wire path", async () => {
    const server = await startServer();
    const match = { allyFormation: formation("UNIT_001"), enemyFormation: formation("UNIT_002") };
    const replay = {
      seed: SEED,
      runIndex: 0,
      expectedCatalogRevision: CATALOG_REVISION,
      expectedEngineRevision: ENGINE_REVISION,
      expectedSeedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
    };

    for (const [overrides, options, path] of [
      [{ expectedCatalogRevision: "other" }, undefined, "/replay/expectedCatalogRevision"],
      [{ expectedEngineRevision: "other" }, undefined, "/replay/expectedEngineRevision"],
      [
        { expectedSeedDerivationVersion: "OTHER" },
        undefined,
        "/replay/expectedSeedDerivationVersion",
      ],
      [{ runIndex: 4294967296 }, undefined, "/replay/runIndex"],
      [{ seed: "  " }, undefined, "/replay/seed"],
      [{}, { logLevel: "SUMMARY" }, "/options/logLevel"],
    ] as const) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/tactical-exercises",
        payload: {
          ...match,
          ...(options !== undefined ? { options } : {}),
          replay: { ...replay, ...overrides },
        },
      });
      expect(response.statusCode).toBe(422);
      expect(
        response.json<ErrorResponseBody>().error.violations.map((violation) => violation.path),
      ).toEqual([path]);
    }
  });

  it("E2E-REPLAY-005: with the evaluation endpoints disabled a replay is 404 while the plain exercise POST keeps its summary contract", async () => {
    const server = await startServer(false);
    const match = { allyFormation: formation("UNIT_001"), enemyFormation: formation("UNIT_002") };

    const replayed = await server.inject({
      method: "POST",
      url: "/api/v1/tactical-exercises",
      payload: {
        ...match,
        replay: {
          seed: SEED,
          runIndex: 0,
          expectedCatalogRevision: CATALOG_REVISION,
          expectedEngineRevision: ENGINE_REVISION,
          expectedSeedDerivationVersion: "MULBERRY32_FNV1A_SPLITMIX32_V1",
        },
      },
    });
    expect(replayed.statusCode).toBe(404);
    expect(replayed.json<ErrorResponseBody>().error.code).toBe("ENDPOINT_DISABLED");

    const plain = await server.inject({
      method: "POST",
      url: "/api/v1/tactical-exercises",
      payload: match,
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.json<TacticalExerciseResponseBody>().events).toEqual([]);
  });
});
