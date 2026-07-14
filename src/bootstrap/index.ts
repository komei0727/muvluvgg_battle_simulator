import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../presentation/http/build-server.js";
import { parseCatalogManifest } from "../infrastructure/catalog/runtime/catalog-manifest.js";
import { SimulationWorkerPool } from "../infrastructure/worker/simulation-worker-pool.js";

/**
 * `11_インフラストラクチャ設計.md`「起動」の骨格。Catalog manifestから
 * `catalogRevision`だけを読み（Workerが実際の全定義を読み込む）、
 * `SimulationWorkerPool`を構築してから`buildServer`へ渡す — これにより
 * HTTPメインスレッドはBattleを直接実行せず、Worker Threadへ委譲する。
 *
 * 構造化ログ・ヘルスチェック・Graceful Shutdown・期限/Pool容量制御の完成は
 * 別Issue（`#12`/`#18`）の範囲。ここでは初期化失敗時にポートを公開せず
 * 非0終了することだけを保証する。
 */
export async function bootstrap(): Promise<void> {
  const port = Number(process.env["PORT"] ?? "3000");
  const host = process.env["HOST"] ?? "0.0.0.0";
  const catalogDir = process.env["CATALOG_PATH"] ?? "catalog";

  let pool: SimulationWorkerPool | undefined;
  try {
    const manifestRaw = readFileSync(join(catalogDir, "manifest.json"), "utf8");
    const manifest = parseCatalogManifest(JSON.parse(manifestRaw));

    pool = new SimulationWorkerPool({ catalogDir, catalogRevision: manifest.catalogRevision });

    const app = await buildServer(pool);
    await app.listen({ port, host });
  } catch (error) {
    console.error("muvluvgg-battle-simulator failed to start:", error);
    await pool?.close();
    process.exit(1);
  }
}
