import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/** 乱数固定＋実行開始latchつきworker entry（`__fixtures__/deterministic-battle-worker.ts`）。 */
const distFixtureWorkerUrl = new URL(
  "../../../dist/infrastructure/worker/__fixtures__/deterministic-battle-worker.js",
  import.meta.url,
);

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

/** Pool直投げの失敗を、HTTPへ写ったときのstatusと対応する分類名へ落とす。 */
function classifyPoolFailure(error: unknown): string {
  if (error instanceof Error && error.name === "SimulationCapacityExceededError") {
    return "CAPACITY_EXCEEDED";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/**
 * 実Poolを`SimulateBattleUseCasePort`として包み、**サーバー側が`execute()`へ入った
 * 瞬間**を通知するlatchと、その`cancellationSignal`を公開する。
 *
 * これが無いと、切断・shutdownの測定が「サーバーがrequestを受け取る前にクライアント側
 * だけで取り消した」状態でも成功してしまう（実測: `fetch()`直後に同期`abort()`すると
 * shutdownは1ms・in-flightは503で、実行中タスクを1件も抱えていなかった）。
 * `build-server.disconnect.integration.test.ts`の`INT-HTTP-DISCONNECT-002`が
 * 偽のUseCaseで使っているlatchと同じ役割を、実Worker Poolのまま与える。
 */
interface ExecutionLatch {
  readonly port: { execute: SimulationWorkerPoolClass["execute"] };
  /** サーバーが`execute()`へ入るまで解決しない。 */
  readonly entered: Promise<void>;
  /** 直近の`execute()`が受け取ったキャンセル信号（クライアント切断で中断される）。 */
  capturedSignal(): AbortSignal | undefined;
}

function latchedPool(pool: SimulationWorkerPoolClass): ExecutionLatch {
  let resolveEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  let signal: AbortSignal | undefined;
  return {
    port: {
      execute: (request, context) => {
        signal = context.cancellationSignal;
        resolveEntered();
        return pool.execute(request, context);
      },
    },
    entered,
    capturedSignal: () => signal,
  };
}

/**
 * 実Poolを包み、`deadlineEpochMs`を必ず過去へ書き換える。`SIMULATION_TIMEOUT_MS=1`
 * では期限超過が乱数任せになる——Workerは`SystemRandomSourceFactory`を使うため
 * 決着ターンが毎回変わり、1ms未満で終わる試行は期限に触れずに200で完走する
 * （実測: 5対5でも10回中2回）。「タイムアウトの連続」を測るには超過を確定させる
 * 必要があるため、`INT-WORKER-005`と同じく過去の期限を渡す。Worker側の
 * 協調的停止（`11_インフラストラクチャ設計.md`「キャンセルと期限」段階1）は
 * production経路そのままで、変えているのは期限の値だけである。
 */
function expiredDeadlinePool(pool: SimulationWorkerPoolClass): {
  execute: SimulationWorkerPoolClass["execute"];
} {
  return {
    execute: (request, context) =>
      pool.execute(request, { ...context, deadlineEpochMs: Date.now() - 1_000 }),
  };
}

/** `signal`が中断されるまで待つ（既に中断済みなら即座に返る）。 */
async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });
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
    const unitIds = allProductionUnitIds(CATALOG_DIR);
    expect(
      unitIds.length,
      "at least five selectable production units are required",
    ).toBeGreaterThan(4);
    // 「1対1短時間戦闘」: 既定のSUMMARYで短いturnLimit。
    shortBattleRequest = {
      allyFormation: soloFormation(unitIds[0]!),
      enemyFormation: soloFormation(unitIds[0]!),
      turnLimit: 5,
    };
    // 「5対5・99ターン・DETAILED」: 公開APIから作れる最大の入力。
    //
    // 最大**応答**を出すのは1対1のUNIT_AOI_GUARDIAN（23.1 MB）だが、それは
    // `LOAD-CAPACITY-*`が定数乱数で決定化した場合の値である。production Workerは
    // `SystemRandomSourceFactory`を使うため、同じ編成でも決着ターンが毎回変わり、
    // 1対1では1ms未満で終わる試行が混ざる（実測: `SIMULATION_TIMEOUT_MS=1`でも
    // 10回中5回が200で完走した）。実経路の測定は乱数に依存せず必ず十分な仕事量に
    // なる5対5の最大編成で行う。
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
    // 期限を必ず超過させ、504経路を連続で通す（`expiredDeadlinePool`の注記参照）。
    app = await buildServer(expiredDeadlinePool(pool));
    let baseUrl = await listenOnEphemeralPort(app);

    const timeoutStatusCounts = new Map<number, number>();
    const cycles = 10;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const { status } = await postSimulation(baseUrl, heavyBattleRequest);
      timeoutStatusCounts.set(status, (timeoutStatusCounts.get(status) ?? 0) + 1);
    }
    const healthyAfterTimeouts = pool.isHealthy;

    await app.close();

    // 切断サイクル。サーバーが`execute()`へ入ったことをlatchで確認してから切断し、
    // **server-side cancellationSignalが実際に中断されるまで**観測する。
    // クライアント側だけで取り消した場合はサーバーが何も知らないまま完走するため、
    // 「切断してもPoolが健全」を検証したことにならない。
    let abortedCount = 0;
    let serverObservedCancellations = 0;
    const cancellationLatencies: number[] = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
      const latch = latchedPool(pool);
      app = await buildServer(latch.port, { simulationTimeoutMs: 30_000 });
      baseUrl = await listenOnEphemeralPort(app);

      const controller = new AbortController();
      const pending = fetch(`${baseUrl}/api/v1/battle-simulations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(heavyBattleRequest),
        signal: controller.signal,
      }).catch((error: unknown) => error);

      await latch.entered;
      const abortStart = performance.now();
      controller.abort();
      await waitForAbort(latch.capturedSignal());
      cancellationLatencies.push(performance.now() - abortStart);
      if (latch.capturedSignal()?.aborted === true) serverObservedCancellations += 1;
      const settled = await pending;
      if (settled instanceof Error) abortedCount += 1;

      await app.close();
      app = undefined;
    }
    const healthyAfterDisconnects = pool.isHealthy;

    app = await buildServer(pool, { simulationTimeoutMs: 30_000 });
    baseUrl = await listenOnEphemeralPort(app);
    const recovered = await postSimulation(baseUrl, shortBattleRequest);

    console.log(
      `[LOAD-HTTP-003] baseline ${JSON.stringify({
        testId: "LOAD-HTTP-003",
        cycles,
        deadlinePolicy: "already-expired",
        timeoutStatusCounts: Object.fromEntries(timeoutStatusCounts),
        abortedCount,
        serverObservedCancellations,
        cancellationLatencyMs: latencySummary(cancellationLatencies),
        poolHealthyAfterTimeouts: healthyAfterTimeouts,
        poolHealthyAfterDisconnects: healthyAfterDisconnects,
        recoveredStatusCode: recovered.status,
      })}`,
    );

    // 期限超過は504であり、勝敗結果へ化けない（`11_インフラストラクチャ設計.md`
    // 「タイムアウトを戦闘の敗北へ変換しない」）。
    expect(timeoutStatusCounts.get(504)).toBe(cycles);
    expect(abortedCount).toBe(cycles);
    // 切断がサーバー側まで届き、実行中タスクのキャンセル信号を毎回中断させた
    // （`11_インフラストラクチャ設計.md`「キャンセルと期限」段階2）。
    expect(serverObservedCancellations).toBe(cycles);
    // 連続タイムアウト・連続切断はWorker障害ではないため、readinessを落とさない。
    expect(healthyAfterTimeouts).toBe(true);
    expect(healthyAfterDisconnects).toBe(true);
    expect(recovered.status).toBe(200);
  }, 300_000);

  it("LOAD-HTTP-004 (12_テスト戦略.md「ローリング終了中の実行」): starts graceful shutdown while the Worker is provably inside an unfinished battle, and measures how long the shutdown waits for it", async () => {
    // Workerがタスクへ入ったことを通知し、解放されるまで待つlatchつきworker entry
    // （`__fixtures__/deterministic-battle-worker.ts`）を使う。`execute()`入口の
    // latch＋固定sleepでは、shutdown開始時点で戦闘が既に終わっていた可能性を
    // 排除できない（実測の`shutdownMs`は1.5msで、待った形跡が無かった）。
    const latchDir = mkdtempSync(join(tmpdir(), "muvluvgg-load-shutdown-"));
    const startedPath = join(latchDir, "started");
    const releasePath = join(latchDir, "release");
    process.env["LOAD_FIXTURE_STARTED_PATH"] = startedPath;
    process.env["LOAD_FIXTURE_RELEASE_PATH"] = releasePath;

    try {
      pool = await SimulationWorkerPool.create({
        catalogDir: CATALOG_DIR,
        catalogRevision,
        minThreads: 1,
        maxThreads: 1,
        maxQueue: 4,
        shutdownGraceMs: 8_000,
        workerFileUrl: distFixtureWorkerUrl,
      });

      // `latched-`で始まるrequestIdのタスクだけがlatchで止まる（warm-upは素通し）。
      const inFlight = pool
        .execute(heavyBattleRequest as BattleSimulationRequestBody, {
          requestId: "latched-shutdown",
          deadlineEpochMs: Date.now() + 30_000,
        })
        .then(() => "COMPLETED")
        .catch((error: unknown) => classifyPoolFailure(error));

      // Workerがhandlerへ入り、かつ戦闘をまだ始めていない状態を直接観測する。
      while (!existsSync(startedPath)) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      const shutdownStart = performance.now();
      const shuttingDown = pool.shutdown();
      // shutdownを開始したうえでWorkerを解放する。ここから先の待ち時間が
      // 「実行中の戦闘をshutdownが待った時間」そのものになる。
      writeFileSync(releasePath, "1");
      await shuttingDown;
      const shutdownMs = performance.now() - shutdownStart;
      const inFlightOutcome = await inFlight;

      console.log(
        `[LOAD-HTTP-004] baseline ${JSON.stringify({
          testId: "LOAD-HTTP-004",
          shutdownGraceMs: 8_000,
          shutdownMs: Number(shutdownMs.toFixed(3)),
          inFlightOutcome,
        })}`,
      );

      // **実行中**タスクを抱えていたことの証明: `close({force:true})`は未開始タスクを
      // 即座にreject（`EXECUTION_CANCELLED`）し、実行中タスクだけを待って完走させる。
      expect(inFlightOutcome).toBe("COMPLETED");
      // shutdownが実際に戦闘の完了を待った（latch解放から戦闘完了までの実時間が
      // 計上されるため、待っていなければこの下限を割る）。
      expect(shutdownMs).toBeGreaterThan(1);
      // その待ち時間がgrace期限内に収まる（Cloud RunのSIGTERM後10秒予算の根拠）。
      expect(shutdownMs).toBeLessThan(8_000);

      pool = undefined;
    } finally {
      delete process.env["LOAD_FIXTURE_STARTED_PATH"];
      delete process.env["LOAD_FIXTURE_RELEASE_PATH"];
      rmSync(latchDir, { recursive: true, force: true });
    }
  }, 300_000);
});
