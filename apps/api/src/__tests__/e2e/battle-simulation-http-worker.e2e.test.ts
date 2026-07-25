import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../../infrastructure/worker/simulation-worker-pool.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * `12_テスト戦略.md`「Main branch」が要求する「HTTP＋WorkerのEnd-to-End」
 * （`CLAUDE.md`「レイヤー構成」の`__tests__/`に置くレイヤー横断テスト）。
 * `presentation`の`buildServer`と`infrastructure`の実`SimulationWorkerPool`を
 * 実際に接続し、`app.inject`でHTTPリクエストを送って
 * `HTTP → Worker → UseCase → Battle → Response`が実Worker Thread経由で
 * 完結することを検証する（`13_実装計画.md`「curl相当の1リクエストで結果を
 * 取得できる」）。個々のレイヤー結合（Worker単体・Pool単体など）は
 * `*.integration.test.ts`が担い、ここはHTTP層を含めた縦切り全体だけを見る。
 *
 * `buildServer`・`SimulationWorkerPool`ともにコンパイル済み`dist/`から
 * importする。Workerの`.js`解決がビルド後前提であることに加え
 * （`simulation-worker-pool.integration.test.ts`と同じ理由）、`buildServer`を
 * `src/`のTSソース（vitestのtransform経由）から読み込むと、Worker側
 * （dist経由）が投げる`ApplicationError`と`build-server.ts`の
 * `error instanceof ApplicationError`判定が別モジュールインスタンスの
 * クラスを比較することになり、常に偽になって500へ落ちてしまう
 * （src版とdist版で`application-error.ts`が別モジュールとして二重ロード
 * されるため）。二重ロードを避けるため、両方を同じdist配下から揃える。
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

const CATALOG_DIR = fixturePath("runtime", "valid", "minimal");
const CATALOG_REVISION = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;

describe("HTTP -> Worker -> UseCase -> Battle -> Response (real Worker Pool wired into the real HTTP server)", () => {
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

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  it("E2E-HTTP-WORKER-001: a real HTTP POST /api/v1/battle-simulations request completes a minimal battle through an actual Piscina Worker Thread, not the HTTP main thread", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
    });
    app = await buildServer(pool);

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
    const body = response.json<{ catalogRevision: string; result: { outcome: string } }>();
    expect(body.catalogRevision).toBe(CATALOG_REVISION);
    expect(body.result.outcome).toEqual(expect.any(String));
  });

  it("E2E-HTTP-WORKER-002: an unsupported/invalid request still surfaces as a normal HTTP error response through the real Worker (not a hung request)", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision: CATALOG_REVISION,
      minThreads: 1,
      maxThreads: 1,
    });
    app = await buildServer(pool);

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
        turnLimit: 0,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_COMMAND");
  });
});
