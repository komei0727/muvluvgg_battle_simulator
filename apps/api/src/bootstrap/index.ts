import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../presentation/http/build-server.js";
import type { ReadinessPort } from "../presentation/http/routes/health-routes.js";
import { parseCatalogManifest } from "../infrastructure/catalog/runtime/catalog-manifest.js";
import { loadBattleCatalogDirectory } from "../infrastructure/catalog/runtime/catalog-file-loader.js";
import { SimulationWorkerPool } from "../infrastructure/worker/simulation-worker-pool.js";
import { GetBattleSimulationCatalogUseCase } from "../application/catalog/get-battle-simulation-catalog-use-case.js";
import { ShutdownState, installShutdownSignalHandlers } from "./shutdown.js";
import { loadConfig } from "./config.js";

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
 * `pool.isHealthy`（稼働中のCatalogリビジョン不一致、または連続Worker障害
 * によるサーキット状態）の両方を見る——`SimulationWorkerPool.create`が
 * 必要ワーカー数のwarm-upとCatalog検証を待ち切ってから返るため、`listen`に
 * 到達した時点でこの2つ以外に readiness を落とす要因は残らない。
 */
export async function bootstrap(): Promise<FastifyInstance> {
  // `11_インフラストラクチャ設計.md`「設定管理」「数値変換失敗や矛盾する期限は
  // 起動エラーにする」（レビュー指摘: 素の`Number()`変換は`SIMULATION_TIMEOUT_MS=abc`
  // を`NaN`へ、`WORKER_MAX_QUEUE=Infinity`を無制限へ、検証なしで通していた）。
  // `config.ts`が投げる`ConfigError`はここで捕まえず、そのまま`bootstrap()`の
  // rejectとして伝播させる——`listen`に到達させず`main.ts`が`process.exit(1)`する。
  const {
    port,
    host,
    catalogDir,
    simulationTimeoutMs,
    workerMaxQueue,
    shutdownGraceMs,
    logLevel,
    docsEnabled,
    corsAllowedOrigins,
  } = loadConfig(process.env);

  const manifestRaw = readFileSync(join(catalogDir, "manifest.json"), "utf8");
  const manifest = parseCatalogManifest(JSON.parse(manifestRaw));

  // `#91`成果物「メインスレッドとWorkerが同じCatalog revisionをロードしてから
  // readyとする」: メインスレッド自身もWorkerと同じRead → Hash → Shape →
  // Resolve → Semanticパイプラインで`catalogDir`を独立に読み込み・検証する
  // （`loadBattleCatalogDirectory`）。両者は同じディレクトリ・同じmanifestを
  // 読むため、`catalogRevision`は構成上一致する——下のWorker Pool向け
  // `manifest.catalogRevision`と同じ値になる。読み込みが失敗すれば
  // （破損Catalogなど）ここで例外を送出し、`listen`へ到達しない
  // （Worker初期化失敗時と同じ「ポートを公開しない」契約）。
  const getBattleSimulationCatalogUseCase = new GetBattleSimulationCatalogUseCase({
    battleCatalogDirectory: loadBattleCatalogDirectory(catalogDir),
  });

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
    catalogUseCase: getBattleSimulationCatalogUseCase,
    docsEnabled,
    corsAllowedOrigins,
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
