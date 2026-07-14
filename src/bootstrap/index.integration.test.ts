import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

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
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: repoRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distBootstrapUrl))).toBe(true);
    const compiled = (await import(distBootstrapUrl.href)) as {
      bootstrap: () => Promise<FastifyInstance>;
    };
    bootstrap = compiled.bootstrap;
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
});
