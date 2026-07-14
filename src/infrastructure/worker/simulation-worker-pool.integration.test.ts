import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  SimulationWorkerPool as SimulationWorkerPoolClass,
  SimulationWorkerPoolStartupError as SimulationWorkerPoolStartupErrorClass,
} from "./simulation-worker-pool.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "./worker-contract.js";
import { loadCatalogFromDirectory } from "../catalog/runtime/catalog-file-loader.js";

/**
 * `13_実装計画.md`「production build後のworker file解決」: `tsx`/Vitest実行時と
 * `tsc`ビルド後とで、Piscinaが解決するワーカーファイルの拡張子が変わる
 * （`simulation-worker-pool.ts`の`resolveDefaultWorkerFileUrl`参照）。この
 * 結合テストは実際に`tsc`でビルドし、コンパイル済み`dist/`配下の
 * `SimulationWorkerPool`を（`src/`のTSソースではなく）importして実Worker
 * Threadを起動することで、production相当の解決経路を検証する。
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tscBin = fileURLToPath(new URL("../../../node_modules/.bin/tsc", import.meta.url));
const distPoolUrl = new URL(
  "../../../dist/infrastructure/worker/simulation-worker-pool.js",
  import.meta.url,
);
const distWorkerEntryUrl = new URL(
  "../../../dist/infrastructure/worker/simulation-worker-entry.js",
  import.meta.url,
);

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../catalog/__fixtures__/${segments.join("/")}`, import.meta.url));
}

const CATALOG_DIR = fixturePath("runtime", "valid", "minimal");
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
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

describe("SimulationWorkerPool (tsc-compiled build, real Worker Thread)", () => {
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  let SimulationWorkerPoolStartupError: typeof SimulationWorkerPoolStartupErrorClass;

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: repoRoot, stdio: "inherit" });
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

    const result = await pool.execute(minimalRequest());

    expect(result.catalogRevision).toBe(CATALOG_REVISION);
    expect(result.outcome).toEqual(expect.any(String));
    expect(result.initialState.currentTurn).toBe(0);
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

    await expect(pool.execute(minimalRequest({ turnLimit: 0 }))).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
  });
});

describe("simulation-worker-entry (compiled build, raw Piscina — Worker Thread recycling)", () => {
  let rawPool: Piscina<WorkerSimulationTask, WorkerSimulationResult> | undefined;

  beforeAll(() => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: repoRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distWorkerEntryUrl))).toBe(true);
  }, 120_000);

  afterEach(async () => {
    if (rawPool !== undefined) {
      await rawPool.destroy();
      rawPool = undefined;
    }
  });

  it("INT-WORKER-005 (11_インフラストラクチャ設計.md「Catalogリビジョンの一致」「Workerを再初期化する」): a mid-life Catalog revision mismatch answers the failing task correctly, then recycles the Worker Thread so a later, correctly-addressed task recovers on a fresh thread", async () => {
    rawPool = new Piscina<WorkerSimulationTask, WorkerSimulationResult>({
      filename: distWorkerEntryUrl.href,
      workerData: { catalogDir: CATALOG_DIR },
      // `simulation-worker-pool.ts`と同じ設定（`atomics: 'disabled'`）を使う。
      // 既定のsync atomics経路は、応答済みタスクの直後にWorkerが自ら終了する
      // ケースで未処理の`error`イベントを発生させることを確認済み。
      atomics: "disabled",
      minThreads: 1,
      maxThreads: 1,
    });

    const originalThreadId = rawPool.threads[0]?.threadId;

    const mismatchedTask: WorkerSimulationTask = {
      requestId: "mismatch",
      request: minimalRequest(),
      deadlineEpochMs: Date.now() + 30_000,
      expectedCatalogRevision: "mismatched-revision",
    };
    const mismatchOutcome = await rawPool.run(mismatchedTask);
    expect(mismatchOutcome).toMatchObject({ ok: false, error: { code: "INVALID_DEFINITION" } });

    // Allow the Worker's deferred `process.exit` (scheduled via `setImmediate`
    // after answering the task above) to actually terminate the thread and
    // Piscina to spin up its replacement.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const matchingTask: WorkerSimulationTask = {
      requestId: "recovered",
      request: minimalRequest(),
      deadlineEpochMs: Date.now() + 30_000,
      expectedCatalogRevision: CATALOG_REVISION,
    };
    const recoveredOutcome = await rawPool.run(matchingTask);
    expect(recoveredOutcome.ok).toBe(true);

    const recycledThreadId = rawPool.threads[0]?.threadId;
    expect(recycledThreadId).not.toBe(originalThreadId);
  });
});
