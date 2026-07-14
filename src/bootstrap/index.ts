import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../presentation/http/build-server.js";
import type { ReadinessPort } from "../presentation/http/health-routes.js";
import { parseCatalogManifest } from "../infrastructure/catalog/runtime/catalog-manifest.js";
import { SimulationWorkerPool } from "../infrastructure/worker/simulation-worker-pool.js";
import { ShutdownState, installShutdownSignalHandlers } from "./shutdown.js";
import { resolveDocsEnabled } from "./docs-enabled.js";

/**
 * `11_インフラストラクチャ設計.md`「起動」の骨格。Catalog manifestから
 * `catalogRevision`だけを読み（Workerが実際の全定義を読み込む）、
 * `SimulationWorkerPool.create`でWorkerの初期化完了（Catalog読み込み・検証・
 * リビジョン一致）をawaitしてから`buildServer`を構築し、最後にlistenする。
 * `create`が失敗すればこの関数自体が例外を送出し、`listen`へ到達しない
 * ——HTTPメインスレッドはBattleを直接実行せず、初期化未完了のままポートを
 * 公開することもない。
 *
 * 失敗時の`process.exit`は呼び出し側（`main.ts`）の責務にする。ここで
 * 揉み消さず素直に投げることで、この関数自体をテストで直接呼び出し、
 * 初期化失敗が確かに`reject`されることを検証できる。
 *
 * `#12`で`/health/live`・`/health/ready`・構造化ログ・Graceful Shutdownを
 * ここへ配線した。`readiness`は`shutdownState`（Graceful Shutdownステップ1）と
 * `pool.isHealthy`（稼働中のCatalogリビジョン不一致）の両方を見る——
 * `SimulationWorkerPool.create`が必要ワーカー数のwarm-upとCatalog検証を
 * 待ち切ってから返るため、`listen`に到達した時点でこの2つ以外に readiness を
 * 落とす要因は残らない。
 */
export async function bootstrap(): Promise<FastifyInstance> {
  const port = Number(process.env["PORT"] ?? "3000");
  const host = process.env["HOST"] ?? "0.0.0.0";
  const catalogDir = process.env["CATALOG_PATH"] ?? "catalog";
  const simulationTimeoutMs = Number(process.env["SIMULATION_TIMEOUT_MS"] ?? "30000");
  // `11_インフラストラクチャ設計.md`「待機キューを無制限にしない」。Piscina自身の
  // 既定`maxQueue`は`Infinity`のため、未設定でも常に有限値を明示する。
  const workerMaxQueue = Number(process.env["WORKER_MAX_QUEUE"] ?? "100");
  const logLevel = process.env["LOG_LEVEL"] ?? "info";
  // `11_インフラストラクチャ設計.md`「設定項目」`SHUTDOWN_GRACE_MS`。Piscina自身の
  // `closeTimeout`既定値と揃える。
  const shutdownGraceMs = Number(process.env["SHUTDOWN_GRACE_MS"] ?? "30000");
  // `11_インフラストラクチャ設計.md`「OpenAPI」「productionではSwagger UIを
  // 既定で公開しない。開発・検証環境だけUIを有効化できる」（#85）。判定ロジック
  // は`docs-enabled.ts`（`docs-enabled.test.ts`が通常のテストスイートで検証）。
  const docsEnabled = resolveDocsEnabled(process.env["NODE_ENV"]);

  const manifestRaw = readFileSync(join(catalogDir, "manifest.json"), "utf8");
  const manifest = parseCatalogManifest(JSON.parse(manifestRaw));

  const pool = await SimulationWorkerPool.create({
    catalogDir,
    catalogRevision: manifest.catalogRevision,
    maxQueue: workerMaxQueue,
    shutdownGraceMs,
  });

  const shutdownState = new ShutdownState();
  // `11_インフラストラクチャ設計.md`「/health/ready」: シャットダウン開始前、かつ
  // Workerのcatalogリビジョンが一致（`pool.isHealthy`）している場合だけ成功する。
  const readiness: ReadinessPort = {
    isReady: () => !shutdownState.isShuttingDown() && pool.isHealthy,
  };

  const app = await buildServer(pool, {
    simulationTimeoutMs,
    logger: { level: logLevel },
    readiness,
    shutdownGate: shutdownState,
    docsEnabled,
  });
  const disposeShutdownSignalHandlers = installShutdownSignalHandlers({ app, pool, shutdownState });
  // レビュー指摘: `process.once`のSIGTERM/SIGINTリスナーは、シグナルが一度も
  // 発火しないまま`bootstrap()`を複数回呼ぶ（結合テストなど）とプロセスへ
  // 残り続ける。`app`のライフサイクルへ同期させ、`app.close()`（直接呼び出しと
  // Graceful Shutdown自身の呼び出しの両方）で確実に解除する。
  app.addHook("onClose", () => {
    disposeShutdownSignalHandlers();
  });

  try {
    await app.listen({ port, host });
  } catch (error) {
    // レビュー指摘: `listen()`がポート競合などで失敗すると、上の`onClose`
    // フック（`app.close()`が呼ばれて初めて発火する）は一切実行されない。
    // ここで明示的に`app.close()`（シグナルリスナーの解除）と`pool.close()`
    // （`create()`が既に起動済みのWorker Threadの即時破棄——ここではまだ
    // トラフィックを受けていないため、`shutdown()`の猶予待ちは不要）を行い、
    // 元のエラーはそのまま再送出して`bootstrap()`の失敗契約を変えない。
    await app.close();
    await pool.close();
    throw error;
  }
  // `11_インフラストラクチャ設計.md`「ログイベント」サーバー起動行の最小field。
  app.log.info(
    { catalogRevision: manifest.catalogRevision, workerMaxQueue, simulationTimeoutMs },
    "muvluvgg-battle-simulator started",
  );
  return app;
}
