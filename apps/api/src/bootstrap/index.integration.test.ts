import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../infrastructure/worker/simulation-worker-pool.js";

/**
 * `11_インフラストラクチャ設計.md`「起動」: 初期化に失敗した場合はポートを
 * 公開せず非0終了する契約を、実`bootstrap()`（コンパイル済み`dist/`。
 * `SimulationWorkerPool`が実Worker Threadを起動するため、`simulation-worker-
 * pool.integration.test.ts`と同じ理由でビルド後のモジュールを使う）を通して
 * 検証する。
 */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const tscBin = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));
const distBootstrapUrl = new URL("../../dist/bootstrap/index.js", import.meta.url);
const distPoolUrl = new URL(
  "../../dist/infrastructure/worker/simulation-worker-pool.js",
  import.meta.url,
);

function fixturePath(...segments: string[]): string {
  return fileURLToPath(
    new URL(`../infrastructure/catalog/__fixtures__/${segments.join("/")}`, import.meta.url),
  );
}

const VALID_CATALOG_DIR = fixturePath("runtime", "valid", "minimal");
const INVALID_CATALOG_DIR = fixturePath("runtime", "invalid", "dangling-reference");

function assertPortIsClosed(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`expected port ${port} to be closed, but a connection succeeded`));
    });
    socket.once("error", () => {
      resolve();
    });
  });
}

describe("bootstrap (compiled build)", () => {
  let bootstrap: () => Promise<FastifyInstance>;
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: repoRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distBootstrapUrl))).toBe(true);
    const compiled = (await import(distBootstrapUrl.href)) as {
      bootstrap: () => Promise<FastifyInstance>;
    };
    bootstrap = compiled.bootstrap;
    // `bootstrap/index.js`が内部でimportするのと同じモジュール（Nodeの
    // ESMキャッシュにより同一URLは同一インスタンス）を明示的にimportし、
    // `SimulationWorkerPool.prototype.close`をspyできるようにする
    // （INT-BOOTSTRAP-005: listen失敗時にPoolが実際にcloseされることの検証）。
    const poolModule = (await import(distPoolUrl.href)) as {
      SimulationWorkerPool: typeof SimulationWorkerPoolClass;
    };
    SimulationWorkerPool = poolModule.SimulationWorkerPool;
  }, 120_000);

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("INT-BOOTSTRAP-001 (11_インフラストラクチャ設計.md「初期化に失敗した場合はポートを公開せず、非0終了する」): rejects and never opens the HTTP port when the Worker's Catalog fails to initialize", async () => {
    const port = 34579;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = INVALID_CATALOG_DIR;

    await expect(bootstrap()).rejects.toBeTruthy();
    await assertPortIsClosed(port);
  });

  it("INT-BOOTSTRAP-002: resolves and actually listens once Worker Catalog initialization succeeds (positive control for INT-BOOTSTRAP-001)", async () => {
    const port = 34580;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = VALID_CATALOG_DIR;

    const app = await bootstrap();
    try {
      expect(app.server.listening).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("INT-BOOTSTRAP-003 (#12 成果物「Composition RootへのAPI・Pool・Catalog配線」「/health/live」「/health/ready」): the compiled build's /health/live and /health/ready both succeed once bootstrap() has resolved (Pool warm-up already confirmed the Catalog and worker count)", async () => {
    const port = 34581;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = VALID_CATALOG_DIR;

    const app = await bootstrap();
    try {
      const live = await app.inject({ method: "GET", url: "/health/live" });
      const ready = await app.inject({ method: "GET", url: "/health/ready" });

      expect(live.statusCode).toBe(200);
      expect(ready.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("INT-BOOTSTRAP-004 (受け入れ条件「最小縦切りをproduction buildで実行できる」): the compiled build still completes a minimal battle end-to-end through POST /api/v1/battle-simulations", async () => {
    const port = 34582;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = VALID_CATALOG_DIR;

    const app = await bootstrap();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: {
          allyFormation: {
            units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
            memoryDefinitionIds: [],
          },
          enemyFormation: {
            units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
            memoryDefinitionIds: [],
          },
          turnLimit: 3,
        },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("INT-BOOTSTRAP-005 (レビュー指摘: listen失敗時はシグナルハンドラーとWorker Poolが残る): when app.listen() itself fails (e.g. the port is already bound by another process), bootstrap() still disposes the SIGTERM/SIGINT listeners and closes the Worker Pool it already created — not just the earlier Worker-Catalog-init failure path (INT-BOOTSTRAP-001), which fails before any of that is created", async () => {
    const port = 34583;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = VALID_CATALOG_DIR;

    const blocker: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, "127.0.0.1", resolve);
    });

    const closeSpy = vi.spyOn(SimulationWorkerPool.prototype, "close");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    try {
      await expect(bootstrap()).rejects.toBeTruthy();

      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("INT-BOOTSTRAP-006 (#85 受け入れ条件「productionではSwagger UIが既定で無効である」): GET /docs is not registered when NODE_ENV=production", async () => {
    const port = 34584;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = VALID_CATALOG_DIR;
    process.env["NODE_ENV"] = "production";

    const app = await bootstrap();
    try {
      const response = await app.inject({ method: "GET", url: "/docs" });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("INT-BOOTSTRAP-007 (#85 受け入れ条件「mise run devで起動後、http://localhost:3000/docsからSwagger UIを確認できる」): GET /docs serves the Swagger UI when NODE_ENV is not production", async () => {
    const port = 34585;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = VALID_CATALOG_DIR;
    process.env["NODE_ENV"] = "development";

    const app = await bootstrap();
    try {
      const response = await app.inject({ method: "GET", url: "/docs" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("INT-BOOTSTRAP-008 (#91 成果物「main threadとWorkerのCatalog revision一致ready check」): the compiled build serves GET /api/v1/battle-simulation-catalog from a main-thread-built read model whose catalogRevision matches the Worker Pool's", async () => {
    const port = 34586;
    process.env["PORT"] = String(port);
    process.env["HOST"] = "127.0.0.1";
    process.env["CATALOG_PATH"] = VALID_CATALOG_DIR;

    const app = await bootstrap();
    try {
      const catalogResponse = await app.inject({
        method: "GET",
        url: "/api/v1/battle-simulation-catalog",
      });
      expect(catalogResponse.statusCode).toBe(200);
      const catalogBody = catalogResponse.json<{
        catalogRevision: string;
        units: readonly { unitDefinitionId: string }[];
      }>();
      expect(catalogBody.catalogRevision).toBe("test-minimal.1");
      expect(catalogBody.units.map((unit) => unit.unitDefinitionId)).toEqual(["UNIT_001"]);

      const battleResponse = await app.inject({
        method: "POST",
        url: "/api/v1/battle-simulations",
        payload: {
          allyFormation: {
            units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
            memoryDefinitionIds: [],
          },
          enemyFormation: {
            units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
            memoryDefinitionIds: [],
          },
          turnLimit: 3,
        },
      });
      const battleBody = battleResponse.json<{ catalogRevision: string }>();
      // メインスレッドが構築したCatalog一覧read modelと、Workerが戦闘で使う
      // Catalogが同じrevisionを指す（`11_インフラストラクチャ設計.md`
      // 「メインスレッドは起動時にmanifestから期待するcatalogRevisionを読み、
      // タスクへ含める。ワーカーのリビジョンが一致しない場合...」の裏取り）。
      expect(catalogBody.catalogRevision).toBe(battleBody.catalogRevision);
    } finally {
      await app.close();
    }
  });
});
