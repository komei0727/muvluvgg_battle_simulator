import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
/** 乱数を固定したworker entry（`__fixtures__/deterministic-battle-worker.ts`のコンパイル結果）。 */
const distFixtureWorkerUrl = new URL(
  "../../../dist/infrastructure/worker/__fixtures__/deterministic-battle-worker.js",
  import.meta.url,
);
/** `LOAD-CAPACITY-003`が最大応答を特定したときと同じ値。 */
const DETERMINISTIC_RANDOM_VALUE = 0.5;

/**
 * 判定基準は配備manifestの`memory` limitそのものを読む。テスト側へ定数で
 * 書き写すと、manifestを変えたときに「収まっているか」の判定だけが古い値の
 * まま残る。
 */
function deployedMemoryLimitBytes(): number {
  const manifestUrl = new URL("../../../../../deploy/cloud-run/service.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf-8")) as {
    spec: {
      template: {
        spec: { containers: ReadonlyArray<{ resources: { limits: { memory: string } } }> };
      };
    };
  };
  const limit = manifest.spec.template.spec.containers[0]?.resources.limits.memory ?? "";
  const match = /^(\d+)Gi$/.exec(limit);
  if (match === null) {
    throw new Error(`unsupported memory limit in the Cloud Run manifest: ${limit}`);
  }
  return Number(match[1]) * 1024 * 1024 * 1024;
}

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

describe("production-path memory capacity baseline", () => {
  let SimulationWorkerPool: typeof SimulationWorkerPoolClass;
  let buildServer: typeof buildServerFn;
  let catalogRevision: string;
  let unitIds: readonly string[];
  let warmUpRequest: unknown;

  beforeAll(async () => {
    execFileSync(tscBin, ["-p", "tsconfig.json"], { cwd: apiPackageRoot, stdio: "inherit" });
    expect(existsSync(fileURLToPath(distPoolUrl))).toBe(true);
    expect(existsSync(fileURLToPath(distBuildServerUrl))).toBe(true);
    expect(existsSync(fileURLToPath(distFixtureWorkerUrl))).toBe(true);
    ({ SimulationWorkerPool } = (await import(distPoolUrl.href)) as {
      SimulationWorkerPool: typeof SimulationWorkerPoolClass;
    });
    ({ buildServer } = (await import(distBuildServerUrl.href)) as {
      buildServer: typeof buildServerFn;
    });

    catalogRevision = loadCatalogFromDirectory(CATALOG_DIR).catalogRevision;
    unitIds = allProductionUnitIds(CATALOG_DIR);
    expect(unitIds.length).toBeGreaterThan(4);
    warmUpRequest = {
      allyFormation: soloFormation(unitIds[0]!),
      enemyFormation: soloFormation(unitIds[0]!),
      turnLimit: 5,
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

  it("LOAD-MEMORY-001 (11_インフラストラクチャ設計.md「最大同時実行数と最悪レスポンスサイズからmemory limitを決める」): drives every production unit's worst-case 99-turn DETAILED battle through the compiled HTTP→Worker path at the deployed concurrency, so the peak RSS covers the largest response the Catalog can produce", async () => {
    const deployedConcurrency = 2;
    const memoryLimitBytes = deployedMemoryLimitBytes();
    // 最大応答を狙って再現するために乱数を固定する（fixtureの注記参照）。
    // production Workerは`SystemRandomSourceFactory`のため決着ターンが試行ごとに
    // 変わり、既知の最悪ケース(23.1 MB)を実経路で再現できない。
    process.env["LOAD_FIXTURE_RANDOM_VALUE"] = String(DETERMINISTIC_RANDOM_VALUE);
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision,
      // 配備値そのもの（`deploy/cloud-run/service.json`）。
      minThreads: 1,
      maxThreads: 1,
      maxQueue: 1,
      workerFileUrl: distFixtureWorkerUrl,
    });
    app = await buildServer(pool);
    const baseUrl = await listenOnEphemeralPort(app);

    // ウォームアップ後に基準を取る。Catalogはメイン・Worker双方が保持済みで、
    // ここから増える分が「requestを捌くために追加で要るメモリー」になる。
    await postSimulation(baseUrl, warmUpRequest);
    if (globalThis.gc) globalThis.gc();
    const baselineRssBytes = process.memoryUsage().rss;

    let peakRssBytes = baselineRssBytes;
    const sampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 5);

    // Catalog全ユニットの1対1・99ターン・DETAILEDを配備並行度で流す。どのユニットが
    // 最悪応答になるかを事前に決め打たず、最悪ケースを必ず含める（`LOAD-CAPACITY-003`
    // が同じ乱数で特定した最悪ケースは、この走査の中に必ず現れる）。
    const statusCounts = new Map<number, number>();
    let maxResponseBytes = 0;
    let heaviestUnitId = "";
    try {
      for (let index = 0; index < unitIds.length; index += deployedConcurrency) {
        const batch = unitIds.slice(index, index + deployedConcurrency);
        const responses = await Promise.all(
          batch.map(async (unitDefinitionId) => ({
            unitDefinitionId,
            ...(await postSimulation(baseUrl, {
              allyFormation: soloFormation(unitDefinitionId),
              enemyFormation: soloFormation(unitDefinitionId),
              turnLimit: 99,
              options: { logLevel: "DETAILED" },
            })),
          })),
        );
        for (const { unitDefinitionId, status, bytes } of responses) {
          statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
          if (bytes > maxResponseBytes) {
            maxResponseBytes = bytes;
            heaviestUnitId = unitDefinitionId;
          }
        }
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }
    } finally {
      clearInterval(sampler);
    }

    console.log(
      `[LOAD-MEMORY-001] baseline ${JSON.stringify({
        testId: "LOAD-MEMORY-001",
        deployedConcurrency,
        unitCount: unitIds.length,
        randomValue: DETERMINISTIC_RANDOM_VALUE,
        statusCounts: Object.fromEntries(statusCounts),
        heaviestUnitId,
        maxResponseBytes,
        baselineRssBytes,
        peakRssBytes,
        peakRssGrowthBytes: peakRssBytes - baselineRssBytes,
        deployedMemoryLimitBytes: memoryLimitBytes,
        peakRssRatioOfLimit: Number((peakRssBytes / memoryLimitBytes).toFixed(3)),
        gcAvailable: Boolean(globalThis.gc),
      })}`,
    );

    // 配備並行度では全requestが成功する（容量拒否が混じると測定が軽くなる）。
    expect(statusCounts.get(200)).toBe(unitIds.length);
    // 測定が「小さい応答しか通っていないのに成功する」ことを防ぐ。既知の最大応答
    // (23.1 MB)級を実際にWorker経路へ通したことを、下限で確認する。
    expect(maxResponseBytes).toBeGreaterThan(20 * 1024 * 1024);
    // Node processのRSSはメインスレッドとWorker Thread（同一プロセス内）の
    // 両方を含む。配備manifestのmemory limitに対して収まっていること。
    expect(peakRssBytes).toBeLessThan(memoryLimitBytes);
  }, 300_000);
});
