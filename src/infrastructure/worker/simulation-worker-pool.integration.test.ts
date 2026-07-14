import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "./simulation-worker-pool.js";
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

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../catalog/__fixtures__/${segments.join("/")}`, import.meta.url));
}

const CATALOG_DIR = fixturePath("runtime", "valid", "minimal");
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;

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

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: repoRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distPoolUrl))).toBe(true);
    const compiled = (await import(distPoolUrl.href)) as {
      SimulationWorkerPool: typeof SimulationWorkerPoolClass;
    };
    SimulationWorkerPool = compiled.SimulationWorkerPool;
  }, 120_000);

  let pool: SimulationWorkerPoolClass | undefined;

  afterEach(async () => {
    if (pool !== undefined) {
      await pool.close();
      pool = undefined;
    }
  });

  it("INT-WORKER-001: completes a minimal battle through the compiled ESM Worker Thread (not the HTTP main thread)", async () => {
    pool = new SimulationWorkerPool({
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

  it("INT-WORKER-002 (11_インフラストラクチャ設計.md「Catalogリビジョンの一致」): rejects a task whose expectedCatalogRevision does not match the Worker's loaded Catalog, without crashing the pool", async () => {
    pool = new SimulationWorkerPool({
      catalogDir: CATALOG_DIR,
      catalogRevision: "mismatched-revision",
      minThreads: 1,
      maxThreads: 1,
    });

    await expect(pool.execute(minimalRequest())).rejects.toMatchObject({
      code: "INVALID_DEFINITION",
    });

    // タスク拒否がWorker/Poolを壊さないこと（`11_インフラストラクチャ設計.md`
    // 「Worker異常を勝敗へ変換しない」の裏側）。
    await expect(pool.execute(minimalRequest())).rejects.toMatchObject({
      code: "INVALID_DEFINITION",
    });
  });

  it("INT-WORKER-003: an ApplicationError raised inside the Worker (e.g. an out-of-range command) surfaces as an ApplicationError in the main thread, not a lost/hung task", async () => {
    pool = new SimulationWorkerPool({
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
