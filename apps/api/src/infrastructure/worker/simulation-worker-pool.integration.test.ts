import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  SimulationWorkerPool as SimulationWorkerPoolClass,
  SimulationWorkerPoolStartupError as SimulationWorkerPoolStartupErrorClass,
} from "./simulation-worker-pool.js";
import { loadCatalogFromDirectory } from "../catalog/runtime/catalog-file-loader.js";

/**
 * M4完了条件「production build後のworker file解決」: `tsx`/Vitest実行時と
 * `tsc`ビルド後とで、Piscinaが解決するワーカーファイルの拡張子が変わる
 * （`simulation-worker-pool.ts`の`resolveDefaultWorkerFileUrl`参照）。この
 * 結合テストは実際に`tsc`でビルドし、コンパイル済み`dist/`配下の
 * `SimulationWorkerPool`を（`src/`のTSソースではなく）importして実Worker
 * Threadを起動することで、production相当の解決経路を検証する。
 */
const apiPackageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tscBin = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const distPoolUrl = new URL(
  "../../../dist/infrastructure/worker/simulation-worker-pool.js",
  import.meta.url,
);

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../catalog/__fixtures__/${segments.join("/")}`, import.meta.url));
}

const CATALOG_DIR = fixturePath("runtime", "valid", "minimal");
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
// R-TEX-11: 演習の敵はEXERCISE_ENEMYユニットでなければならないため、演習を流す
// テストはUNIT_002（EXERCISE_ENEMY）入りのfixtureを使う。
const EXERCISE_CATALOG_DIR = fixturePath("runtime", "valid", "exercise");
const EXERCISE_CATALOG_REVISION = loadCatalogFromDirectory(EXERCISE_CATALOG_DIR).catalogRevision;
const INVALID_CATALOG_DIR = fixturePath("runtime", "invalid", "dangling-reference");

function minimalRequest(overrides: Record<string, unknown> = {}) {
  return {
    allyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    enemyFormation: {
      units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    },
    turnLimit: 3,
    ...overrides,
  };
}

function freshContext(requestId: string, deadlineEpochMs = Date.now() + 30_000) {
  return { requestId, deadlineEpochMs };
}

describe("SimulationWorkerPool (tsc-compiled build, real Worker Thread)", () => {
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  let SimulationWorkerPoolStartupError: typeof SimulationWorkerPoolStartupErrorClass;

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: apiPackageRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distPoolUrl))).toBe(true);
    const compiled = (await import(distPoolUrl.href)) as {
      SimulationWorkerPool: typeof SimulationWorkerPoolClass;
      SimulationWorkerPoolStartupError: typeof SimulationWorkerPoolStartupErrorClass;
    };
    SimulationWorkerPool = compiled.SimulationWorkerPool;
    SimulationWorkerPoolStartupError = compiled.SimulationWorkerPoolStartupError;
  }, 120_000);

  let pool: SimulationWorkerPoolClass | undefined;

  afterEach(async () => {
    if (pool !== undefined) {
      await pool.close();
      pool = undefined;
    }
  });

  it("INT-WORKER-001: completes a minimal battle through the compiled ESM Worker Thread (not the HTTP main thread)", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
    });

    const result = await pool.execute(minimalRequest(), freshContext("req-1"));

    expect(result.catalogRevision).toBe(CATALOG_REVISION);
    expect(result.outcome).toEqual(expect.any(String));
    expect(result.initialState.currentTurn).toBe(0);
  });

  it("INT-WORKER-006 (09_アプリケーション設計.md「実行境界」): a TACTICAL_EXERCISE task runs through the same compiled Worker Pool and returns an exercise result, while the battle task on the same pool keeps returning a battle result", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: EXERCISE_CATALOG_DIR,
      catalogRevision: EXERCISE_CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
    });

    const { turnLimit: _turnLimit, ...exerciseRequest } = minimalRequest({
      enemyFormation: {
        units: [{ unitDefinitionId: "UNIT_002", position: { column: 0, row: "FRONT" } }],
        memoryDefinitionIds: [],
      },
    });
    const exercise = await pool.executeTacticalExercise(
      exerciseRequest,
      freshContext("req-exercise-1"),
    );

    expect(exercise.catalogRevision).toBe(EXERCISE_CATALOG_REVISION);
    // R-TEX-09 #1 / R-TEX-10 #1: 演習は勝敗を持たず、5ターンを超えない。
    expect(exercise).not.toHaveProperty("outcome");
    expect(exercise.completedTurn).toBeLessThanOrEqual(5);
    expect(["TURN_LIMIT_REACHED", "ALLY_DEFEATED"]).toContain(exercise.completionReason);
    expect(exercise.breaks).toHaveLength(exercise.breakCount);

    const battle = await pool.execute(minimalRequest(), freshContext("req-battle-1"));
    expect(battle.outcome).toEqual(expect.any(String));
    expect(battle).not.toHaveProperty("totalScore");
  });

  it("INT-WORKER-002 (11_インフラストラクチャ設計.md「必要数のワーカーを初期化できなければHTTP readinessも失敗させる」): create() rejects when the expected catalogRevision does not match the Worker's loaded Catalog, so the caller never obtains a usable pool", async () => {
    await expect(
      SimulationWorkerPool.create({
        catalogDir: CATALOG_DIR,
        catalogRevision: "mismatched-revision",
        minThreads: 1,
        maxThreads: 1,
      }),
    ).rejects.toBeInstanceOf(SimulationWorkerPoolStartupError);
  });

  it("INT-WORKER-003 (11_インフラストラクチャ設計.md「ワーカーがCatalog初期化に失敗した場合、Ready状態にしない」): create() rejects when the Catalog itself is structurally invalid", async () => {
    await expect(
      SimulationWorkerPool.create({
        catalogDir: INVALID_CATALOG_DIR,
        catalogRevision: "irrelevant-because-catalog-load-throws-first",
        minThreads: 1,
        maxThreads: 1,
      }),
    ).rejects.toBeInstanceOf(SimulationWorkerPoolStartupError);
  });

  it("INT-WORKER-004: an ApplicationError raised inside the Worker (e.g. an out-of-range command) surfaces as an ApplicationError in the main thread, not a lost/hung task", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
    });

    await expect(
      pool.execute(minimalRequest({ turnLimit: 0 }), freshContext("req-2")),
    ).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
  });

  it("INT-WORKER-005 (11_インフラストラクチャ設計.md「キャンセルと期限」段階1): a deadline already in the past surfaces as EXECUTION_TIMEOUT through the real compiled Worker, not a battle result", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
    });

    await expect(
      pool.execute(minimalRequest(), freshContext("req-3", Date.now() - 1_000)),
    ).rejects.toMatchObject({ code: "EXECUTION_TIMEOUT" });
  });
  it("INT-WORKER-007 (11_インフラストラクチャ設計.md「SimulationExecutionGuard」「上限値は設定から受け取る」): the configured execution limits cross the Worker Thread boundary via workerData, so SIMULATION_MAX_* bounds the compiled production path", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
      // 既定(1,000,000)なら完走する最小戦闘を、1件目のイベントで止める。
      // 構造化クローンされてWorker側の`SimulateBattleUseCase`まで届かなければ
      // 既定値のまま完走し、この期待は満たされない。
      executionLimits: {
        maxTotalEvents: 1,
        maxPassiveDepth: 8,
        maxEffectsPerScope: 50,
        maxEffectRuntimeCounterDepth: 10,
      },
    });

    await expect(pool.execute(minimalRequest(), freshContext("req-limits"))).rejects.toMatchObject({
      code: "EXECUTION_LIMIT_EXCEEDED",
    });
  });
});
