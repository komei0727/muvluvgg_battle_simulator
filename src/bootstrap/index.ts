import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../presentation/http/build-server.js";
import { parseCatalogManifest } from "../infrastructure/catalog/runtime/catalog-manifest.js";
import { SimulationWorkerPool } from "../infrastructure/worker/simulation-worker-pool.js";

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
 * 構造化ログ・ヘルスチェック・Graceful Shutdownの完成は別Issue（`#12`）の範囲。
 * `SIMULATION_TIMEOUT_MS`・`WORKER_MAX_QUEUE`は`#18`でここから配線した。
 */
export async function bootstrap(): Promise<FastifyInstance> {
  const port = Number(process.env["PORT"] ?? "3000");
  const host = process.env["HOST"] ?? "0.0.0.0";
  const catalogDir = process.env["CATALOG_PATH"] ?? "catalog";
  const simulationTimeoutMs = Number(process.env["SIMULATION_TIMEOUT_MS"] ?? "30000");
  // `11_インフラストラクチャ設計.md`「待機キューを無制限にしない」。Piscina自身の
  // 既定`maxQueue`は`Infinity`のため、未設定でも常に有限値を明示する。
  const workerMaxQueue = Number(process.env["WORKER_MAX_QUEUE"] ?? "100");

  const manifestRaw = readFileSync(join(catalogDir, "manifest.json"), "utf8");
  const manifest = parseCatalogManifest(JSON.parse(manifestRaw));

  const pool = await SimulationWorkerPool.create({
    catalogDir,
    catalogRevision: manifest.catalogRevision,
    maxQueue: workerMaxQueue,
  });

  const app = await buildServer(pool, { simulationTimeoutMs });
  await app.listen({ port, host });
  return app;
}
