import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../../infrastructure/worker/simulation-worker-pool.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { allProductionUnitIds } from "../../testing/scenario/run-production-battle.js";

/**
 * REL-005（Issue #198）のメモリー容量測定。`11_インフラストラクチャ設計.md`
 * 「ワーカーごとにCatalogと結果をメモリー保持するため、最大同時実行数と最悪
 * レスポンスサイズからmemory limitを決める」の根拠を、**コンパイル済みの
 * production経路**（`dist/`の`buildServer` + 実`SimulationWorkerPool` + 実Worker
 * Thread）を配備値どおりに組んで測る。
 *
 * このファイルを`http-capacity.load.test.ts`から分けているのは、Vitestが
 * **ファイル単位**で別プロセスへ隔離するためである。同じプロセスで先に大量の
 * in-process戦闘を回すと、その残骸でRSSの絶対値が数百MB膨らみ（実測: 573 MB）、
 * 「1 GiBに収まるか」の判断材料にならなくなる。ここでは測定対象以外を一切
 * 実行しない。
 *
 * Node.jsのWorker Threadは同一プロセス内で動くため、`process.memoryUsage().rss`は
 * メインスレッドとWorkerの両方を含む。containerのoverhead（Node本体・OS）は
 * 含まないため、1 GiBに対する余裕はこの値＋一定のマージンで判断する。
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
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

async function listenOnEphemeralPort(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an AddressInfo from the listening server");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function postSimulation(
  baseUrl: string,
  body: unknown,
): Promise<{ readonly status: number; readonly bytes: number }> {
  const response = await fetch(`${baseUrl}/api/v1/battle-simulations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text, "utf8") };
}

function soloFormation(unitDefinitionId: string) {
  return {
    units: [{ unitDefinitionId, position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  };
}

/** 5枠（前列3・後列2）を左から詰めた最大編成。 */
function partyFormation(unitDefinitionIds: readonly string[]) {
  return {
    units: unitDefinitionIds.map((unitDefinitionId, index) => ({
      unitDefinitionId,
      position: { column: index % 3, row: index < 3 ? "FRONT" : "REAR" },
    })),
    memoryDefinitionIds: [],
  };
}

describe("production-path memory capacity baseline", () => {
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  let buildServer: typeof buildServerFn;
  let catalogRevision: string;
  let shortBattleRequest: unknown;
  let heavyBattleRequest: unknown;

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: apiPackageRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distPoolUrl))).toBe(true);
    expect(existsSync(fileURLToPath(distBuildServerUrl))).toBe(true);
    ({ SimulationWorkerPool } = (await import(distPoolUrl.href)) as {
      SimulationWorkerPool: typeof SimulationWorkerPoolClass;
    });
    ({ buildServer } = (await import(distBuildServerUrl.href)) as {
      buildServer: typeof buildServerFn;
    });

    catalogRevision = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
    const unitIds = allProductionUnitIds(CATALOG_DIR);
    expect(unitIds.length).toBeGreaterThan(4);
    shortBattleRequest = {
      allyFormation: soloFormation(unitIds[0]!),
      enemyFormation: soloFormation(unitIds[0]!),
      turnLimit: 5,
    };
    heavyBattleRequest = {
      allyFormation: partyFormation(unitIds.slice(0, 5)),
      enemyFormation: partyFormation(unitIds.slice(0, 5)),
      turnLimit: 99,
      options: { logLevel: "DETAILED" },
    };
  }, 300_000);

  let pool: SimulationWorkerPoolClass | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  it("LOAD-MEMORY-001 (11_インフラストラクチャ設計.md「最大同時実行数と最悪レスポンスサイズからmemory limitを決める」): measures the process peak RSS of the compiled HTTP→Worker path while the heaviest response is produced at the deployed container concurrency", async () => {
    const deployedConcurrency = 2;
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision,
      // 配備値そのもの（`deploy/cloud-run/service.json`）。
      minThreads: 1,
      maxThreads: 1,
      maxQueue: 1,
    });
    app = await buildServer(pool);
    const baseUrl = await listenOnEphemeralPort(app);

    // ウォームアップ後に基準を取る。Catalogはメイン・Worker双方が保持済みで、
    // ここから増える分が「requestを捌くために追加で要るメモリー」になる。
    await postSimulation(baseUrl, shortBattleRequest);
    if (globalThis.gc) globalThis.gc();
    const baselineRssBytes = process.memoryUsage().rss;

    let peakRssBytes = baselineRssBytes;
    const sampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 5);

    const rounds = 5;
    const statusCounts = new Map<number, number>();
    let maxResponseBytes = 0;
    try {
      for (let round = 0; round < rounds; round++) {
        const responses = await Promise.all(
          Array.from({ length: deployedConcurrency }, () =>
            postSimulation(baseUrl, heavyBattleRequest),
          ),
        );
        for (const { status, bytes } of responses) {
          statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
          maxResponseBytes = Math.max(maxResponseBytes, bytes);
        }
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }
    } finally {
      clearInterval(sampler);
    }

    console.log(
      `[LOAD-MEMORY-001] baseline ${JSON.stringify({
        testId: "LOAD-MEMORY-001",
        formation: "5v5",
        deployedConcurrency,
        rounds,
        statusCounts: Object.fromEntries(statusCounts),
        maxResponseBytes,
        baselineRssBytes,
        peakRssBytes,
        peakRssGrowthBytes: peakRssBytes - baselineRssBytes,
        gcAvailable: Boolean(globalThis.gc),
      })}`,
    );

    // 配備並行度では全requestが成功する（容量拒否が混じると測定が軽くなる）。
    expect(statusCounts.get(200)).toBe(rounds * deployedConcurrency);
    // Node processのRSSはメインスレッドとWorker Thread（同一プロセス内）の
    // 両方を含む。containerの1 GiB上限に対して収まっていること。
    expect(peakRssBytes).toBeLessThan(1024 * 1024 * 1024);
  }, 300_000);
});
