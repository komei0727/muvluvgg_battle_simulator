import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { buildServer as buildServerFn } from "../../presentation/http/build-server.js";
import type { SimulationWorkerPool as SimulationWorkerPoolClass } from "../../infrastructure/worker/simulation-worker-pool.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";
import { allProductionUnitIds } from "../../testing/scenario/run-production-battle.js";
import type { BattleSimulationRequestBody } from "../../application/contracts/request.js";

/**
 * REL-005（Issue #198）の容量測定のうち、HTTP・Worker Poolを含む実経路の部分
 * （`12_テスト戦略.md`「負荷・耐久テスト」シナリオの「1対1短時間戦闘の高並行実行」
 * 「Pool満杯の継続負荷」「クライアント切断とタイムアウトの連続」
 * 「ローリング終了中の実行」）。Battle実行そのものの容量は
 * `execution-capacity.load.test.ts`が持つ。
 *
 * `dist/`のコンパイル済み`buildServer`・`SimulationWorkerPool`をimportするのは、
 * `battle-simulation-http-worker.e2e.test.ts`と同じ二重モジュールロード回避のため
 * （src版とdist版で`ApplicationError`が別クラスになり、`instanceof`が常に偽になる）。
 *
 * 測定値は`console.log`へJSONで出力し、`docs/運用手順.md`「Cloud Run配備構成」の
 * M9確定値（container concurrency・`WORKER_MAX_QUEUE`・`WORKER_MAX_THREADS`・
 * `SIMULATION_TIMEOUT_MS`・`SHUTDOWN_GRACE_MS`）を決める根拠にする。
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

/** Cloud Runのcontainer concurrency候補。1 vCPUで測って確定値を選ぶ。 */
const CONCURRENCY_CANDIDATES = [1, 2, 4] as const;
const REQUESTS_PER_CANDIDATE = 24;

function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.floor((p / 100) * sortedAscending.length),
  );
  return sortedAscending[index]!;
}

/**
 * `app.inject()`（light-my-request）は実ソケットを介さないため、同時投入した
 * requestがPoolへ到達する時刻が実HTTPどおりに重ならない（実測: Worker 1本・
 * 待機1枠へ16並行で投げても容量拒否が1件も起きない）。容量・並行度の測定は
 * `build-server.disconnect.integration.test.ts`と同じく実`listen()`＋実`fetch`で行う。
 */
async function listenOnEphemeralPort(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an AddressInfo from the listening server");
  }
  return `http://127.0.0.1:${address.port}`;
}

/** 応答本文を読み切ってから返す（読み捨てるとサーバー側の送信完了を測れない）。 */
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

/** Pool直投げの失敗を、HTTPへ写ったときのstatusと対応する分類名へ落とす。 */
function classifyPoolFailure(error: unknown): string {
  if (error instanceof Error && error.name === "SimulationCapacityExceededError") {
    return "CAPACITY_EXCEEDED";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "UNKNOWN";
}

function latencySummary(durationsMs: readonly number[]): Record<string, number> {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return {
    p50: Number(percentile(sorted, 50).toFixed(3)),
    p95: Number(percentile(sorted, 95).toFixed(3)),
    p99: Number(percentile(sorted, 99).toFixed(3)),
    max: Number((sorted.at(-1) ?? 0).toFixed(3)),
  };
}

describe("HTTP and Worker Pool capacity baseline", () => {
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
    const [unitId] = allProductionUnitIds(CATALOG_DIR);
    expect(unitId, "at least one selectable production unit is required").toBeDefined();
    const formation = {
      units: [{ unitDefinitionId: unitId!, position: { column: 0, row: "FRONT" } }],
      memoryDefinitionIds: [],
    };
    // 「1対1短時間戦闘」: 既定のSUMMARYで短いturnLimit。
    shortBattleRequest = {
      allyFormation: formation,
      enemyFormation: formation,
      turnLimit: 5,
    };
    // 「大きなイベント・状態差分」: 99ターン・DETAILEDの最大応答。
    heavyBattleRequest = {
      allyFormation: formation,
      enemyFormation: formation,
      turnLimit: 99,
      options: { logLevel: "DETAILED" },
    };
  }, 180_000);

  let pool: SimulationWorkerPoolClass | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    await pool?.close();
    pool = undefined;
    app = undefined;
  });

  it("LOAD-HTTP-001 (12_テスト戦略.md「1対1短時間戦闘の高並行実行」): measures HTTP latency percentiles and event loop delay at each container concurrency candidate on a single Worker, so the Cloud Run containerConcurrency can be chosen from data", async () => {
    const perCandidate: Record<string, unknown>[] = [];

    for (const concurrency of CONCURRENCY_CANDIDATES) {
      pool = await SimulationWorkerPool.create({
        catalogDir: CATALOG_DIR,
        catalogRevision,
        // 1 vCPU相当: メインスレッドと共有する前提でWorkerは1本。
        minThreads: 1,
        maxThreads: 1,
        // 容量測定では拒否ではなく待ち行列の伸びを見たいので、十分な待機枠を取る。
        maxQueue: REQUESTS_PER_CANDIDATE,
      });
      app = await buildServer(pool);
      const baseUrl = await listenOnEphemeralPort(app);

      // ウォームアップ（JIT・初回割り当てを baseline から除外）。
      await postSimulation(baseUrl, shortBattleRequest);

      const loopDelay = monitorEventLoopDelay({ resolution: 1 });
      loopDelay.enable();
      const durationsMs: number[] = [];
      const statusCounts = new Map<number, number>();

      const runOne = async (): Promise<void> => {
        const start = performance.now();
        const { status } = await postSimulation(baseUrl, shortBattleRequest);
        durationsMs.push(performance.now() - start);
        statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
      };

      const wallStart = performance.now();
      for (let sent = 0; sent < REQUESTS_PER_CANDIDATE; sent += concurrency) {
        const batch = Math.min(concurrency, REQUESTS_PER_CANDIDATE - sent);
        await Promise.all(Array.from({ length: batch }, runOne));
      }
      const wallMs = performance.now() - wallStart;
      loopDelay.disable();

      perCandidate.push({
        containerConcurrency: concurrency,
        requests: REQUESTS_PER_CANDIDATE,
        wallMs: Number(wallMs.toFixed(3)),
        throughputPerSecond: Number(((REQUESTS_PER_CANDIDATE / wallMs) * 1000).toFixed(2)),
        latencyMs: latencySummary(durationsMs),
        // イベントループ遅延（ms）。HTTPメインスレッドがBattleで詰まっていないかを見る。
        eventLoopDelayMs: {
          p50: Number((loopDelay.percentile(50) / 1e6).toFixed(3)),
          p99: Number((loopDelay.percentile(99) / 1e6).toFixed(3)),
          max: Number((loopDelay.max / 1e6).toFixed(3)),
        },
        statusCounts: Object.fromEntries(statusCounts),
      });

      await app.close();
      await pool.close();
      app = undefined;
      pool = undefined;
    }

    console.log(
      `[LOAD-HTTP-001] baseline ${JSON.stringify({ testId: "LOAD-HTTP-001", perCandidate })}`,
    );

    // どの並行度でも全リクエストが応答を返し切る（ハングしない）。
    for (const candidate of perCandidate) {
      const statuses = candidate["statusCounts"] as Record<string, number>;
      const answered = Object.values(statuses).reduce((total, count) => total + count, 0);
      expect(answered).toBe(REQUESTS_PER_CANDIDATE);
      expect(statuses["200"]).toBe(REQUESTS_PER_CANDIDATE);
    }
  }, 300_000);

  /**
   * 飽和はHTTPではなくPool APIへ直接投げて作る。負荷生成側がサーバーと同じ
   * イベントループを共有するため、実`fetch`で16並行投げてもrequestがPoolへ届く
   * 時刻がばらけ、Worker 1本・待機1枠でも容量拒否が1件も起きない（実測: 128件
   * すべて200）。`build-server.ts`は`pool.execute`の失敗をそのままHTTP status
   * （`CAPACITY_EXCEEDED`→503）へ写す薄い層なので、容量そのものの測定は
   * この境界で行うほうが飽和を確実に作れる。並行度とレイテンシの測定は
   * `LOAD-HTTP-001`が実HTTPで担う。
   */
  it("LOAD-HTTP-002 (12_テスト戦略.md「Pool満杯の継続負荷」): measures how a saturated pool splits between completed tasks and CAPACITY_EXCEEDED (HTTP 503) rejections, and confirms the pool keeps serving after sustained saturation", async () => {
    const maxQueue = 1;
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision,
      minThreads: 1,
      maxThreads: 1,
      maxQueue,
    });

    const outcomeCounts = new Map<string, number>();
    const durationsMs: number[] = [];
    const rounds = 8;
    // Worker 1本＋待機1枠に対して十分大きいburstにする。
    const burst = 16;

    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        Array.from({ length: burst }, async (_unused, index) => {
          const start = performance.now();
          const outcome = await pool!
            .execute(heavyBattleRequest as BattleSimulationRequestBody, {
              requestId: `saturation-${round}-${index}`,
              deadlineEpochMs: Date.now() + 30_000,
            })
            .then(() => "COMPLETED")
            .catch((error: unknown) => classifyPoolFailure(error));
          durationsMs.push(performance.now() - start);
          outcomeCounts.set(outcome, (outcomeCounts.get(outcome) ?? 0) + 1);
        }),
      );
    }

    // 実配備の並行度（Cloud Run containerConcurrency）ちょうどで投げたときに
    // 容量拒否が起きないことを確かめる — `WORKER_MAX_QUEUE`は「濫用を切る」
    // ためのものであり、正規のトラフィックを503にするためのものではない。
    const atDeployedConcurrency = new Map<string, number>();
    const deployedConcurrency = 2;
    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        Array.from({ length: deployedConcurrency }, async (_unused, index) => {
          const outcome = await pool!
            .execute(heavyBattleRequest as BattleSimulationRequestBody, {
              requestId: `at-concurrency-${round}-${index}`,
              deadlineEpochMs: Date.now() + 30_000,
            })
            .then(() => "COMPLETED")
            .catch((error: unknown) => classifyPoolFailure(error));
          atDeployedConcurrency.set(outcome, (atDeployedConcurrency.get(outcome) ?? 0) + 1);
        }),
      );
    }

    // 飽和が去った後も通常どおり応答する（容量拒否でPoolが毒されない）。
    const healthyAfterSaturation = pool.isHealthy;
    const afterSaturation = await pool
      .execute(shortBattleRequest as BattleSimulationRequestBody, {
        requestId: "after-saturation",
        deadlineEpochMs: Date.now() + 30_000,
      })
      .then(() => "COMPLETED")
      .catch((error: unknown) => classifyPoolFailure(error));

    console.log(
      `[LOAD-HTTP-002] baseline ${JSON.stringify({
        testId: "LOAD-HTTP-002",
        workerMaxQueue: maxQueue,
        maxThreads: 1,
        tasks: rounds * burst,
        outcomeCounts: Object.fromEntries(outcomeCounts),
        latencyMs: latencySummary(durationsMs),
        deployedConcurrency,
        outcomeCountsAtDeployedConcurrency: Object.fromEntries(atDeployedConcurrency),
        poolHealthyAfterSaturation: healthyAfterSaturation,
        recoveredOutcome: afterSaturation,
      })}`,
    );

    expect(outcomeCounts.get("COMPLETED") ?? 0).toBeGreaterThan(0);
    // 容量超過は`CAPACITY_EXCEEDED`（HTTP 503）であり、期限超過やハングにならない
    // （`12_テスト戦略.md`「容量と障害」「Pool満杯を503 CAPACITY_EXCEEDEDにする」）。
    expect(outcomeCounts.get("CAPACITY_EXCEEDED") ?? 0).toBeGreaterThan(0);
    for (const outcome of outcomeCounts.keys()) {
      expect(["COMPLETED", "CAPACITY_EXCEEDED"]).toContain(outcome);
    }
    // 配備並行度ちょうどでは1件も拒否されない（`maxThreads`1本＋`maxQueue`1枠で
    // container concurrency 2をちょうど受け切る）。
    expect(atDeployedConcurrency.get("COMPLETED")).toBe(rounds * deployedConcurrency);
    // 容量拒否はWorker障害ではないため、readinessを落とさない。
    expect(healthyAfterSaturation).toBe(true);
    expect(afterSaturation).toBe("COMPLETED");
  }, 300_000);

  it("LOAD-HTTP-003 (12_テスト戦略.md「クライアント切断とタイムアウトの連続」): measures repeated timeout and client-disconnect cycles and confirms the pool stays healthy and answers normally afterwards", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision,
      minThreads: 1,
      maxThreads: 1,
      maxQueue: 4,
    });
    // 最大応答の戦闘が確実に間に合わない期限にし、504経路を連続で通す。
    app = await buildServer(pool, { simulationTimeoutMs: 1 });
    let baseUrl = await listenOnEphemeralPort(app);

    const timeoutStatusCounts = new Map<number, number>();
    const cycles = 10;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const { status } = await postSimulation(baseUrl, heavyBattleRequest);
      timeoutStatusCounts.set(status, (timeoutStatusCounts.get(status) ?? 0) + 1);
    }
    const healthyAfterTimeouts = pool.isHealthy;

    await app.close();
    // 期限を戻し、同じPoolで切断サイクルを通す。
    app = await buildServer(pool, { simulationTimeoutMs: 30_000 });
    baseUrl = await listenOnEphemeralPort(app);

    let abortedCount = 0;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const controller = new AbortController();
      const pending = fetch(`${baseUrl}/api/v1/battle-simulations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(heavyBattleRequest),
        signal: controller.signal,
      });
      // 受付直後に切断する（`11_インフラストラクチャ設計.md`「クライアント切断時は
      // 応答送信を試みない」の連続実行）。
      controller.abort();
      await pending.catch(() => {
        abortedCount += 1;
      });
    }
    const healthyAfterDisconnects = pool.isHealthy;

    const recovered = await postSimulation(baseUrl, shortBattleRequest);

    console.log(
      `[LOAD-HTTP-003] baseline ${JSON.stringify({
        testId: "LOAD-HTTP-003",
        cycles,
        simulationTimeoutMs: 1,
        timeoutStatusCounts: Object.fromEntries(timeoutStatusCounts),
        abortedCount,
        poolHealthyAfterTimeouts: healthyAfterTimeouts,
        poolHealthyAfterDisconnects: healthyAfterDisconnects,
        recoveredStatusCode: recovered.status,
      })}`,
    );

    // 期限超過は504であり、勝敗結果へ化けない（`11_インフラストラクチャ設計.md`
    // 「タイムアウトを戦闘の敗北へ変換しない」）。
    expect(timeoutStatusCounts.get(504)).toBe(cycles);
    expect(abortedCount).toBe(cycles);
    // 連続タイムアウト・連続切断はWorker障害ではないため、readinessを落とさない。
    expect(healthyAfterTimeouts).toBe(true);
    expect(healthyAfterDisconnects).toBe(true);
    expect(recovered.status).toBe(200);
  }, 300_000);

  it("LOAD-HTTP-004 (12_テスト戦略.md「ローリング終了中の実行」): measures how long graceful shutdown takes with a battle in flight, so SHUTDOWN_GRACE_MS can be set below the Cloud Run SIGTERM budget", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: CATALOG_DIR,
      catalogRevision,
      minThreads: 1,
      maxThreads: 1,
      maxQueue: 4,
      shutdownGraceMs: 8_000,
    });
    app = await buildServer(pool);
    const baseUrl = await listenOnEphemeralPort(app);

    // 最大応答の戦闘を投入し、完了を待たずにshutdownへ入る。
    const inFlight = postSimulation(baseUrl, heavyBattleRequest)
      .then(({ status }) => status)
      .catch(() => -1);

    const shutdownStart = performance.now();
    await pool.shutdown();
    const shutdownMs = performance.now() - shutdownStart;
    const inFlightStatus = await inFlight;

    console.log(
      `[LOAD-HTTP-004] baseline ${JSON.stringify({
        testId: "LOAD-HTTP-004",
        shutdownGraceMs: 8_000,
        shutdownMs: Number(shutdownMs.toFixed(3)),
        inFlightStatusCode: inFlightStatus,
      })}`,
    );

    // 実行中タスクを抱えたshutdownがgrace期限内に完了する（Cloud RunのSIGTERM後
    // 10秒予算に収まることの根拠）。
    expect(shutdownMs).toBeLessThan(8_000);
    // 途中状態を勝敗として返さない: 完走した200か、キャンセル扱いのエラーのみ。
    expect([200, 500, 503, 504]).toContain(inFlightStatus);

    pool = undefined;
  }, 300_000);
});
