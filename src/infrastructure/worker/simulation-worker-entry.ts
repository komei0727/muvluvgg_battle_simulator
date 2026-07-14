import { workerData } from "node:worker_threads";
import { createSimulationTaskRunner } from "./simulation-task-runner.js";
import { UuidBattleIdGenerator } from "../identity/uuid-battle-id-generator.js";
import { SystemRandomSourceFactory } from "../random/system-random-source.js";
import { loadCatalogFromDirectory } from "../catalog/runtime/catalog-file-loader.js";

/**
 * `11_インフラストラクチャ設計.md`「ワーカー初期化」: Piscinaがこのモジュールを
 * Worker Threadとしてロードした時点（最初のタスク受入前）で一度だけCatalogを
 * 読み込み、不変な`InMemoryBattleCatalog`とApplication/Domain依存を組み立てる。
 * Catalog不整合はここで例外として送出され、そのWorkerはReady状態にならない
 * （`SimulationWorkerPool`側でWorker起動失敗として扱われる）。
 *
 * Composition Rootの一部であり、ドメインルールを持たない薄い接続層に留める。
 * 実際のCatalog読み込み・タスク実行ロジックは単体テスト可能な
 * `simulation-task-runner.ts`へ委譲する。
 */
interface SimulationWorkerData {
  readonly catalogDir: string;
}

const { catalogDir } = workerData as SimulationWorkerData;
const catalog = loadCatalogFromDirectory(catalogDir);

export default createSimulationTaskRunner(catalog, {
  battleIdGenerator: new UuidBattleIdGenerator(),
  randomSourceFactory: new SystemRandomSourceFactory(),
});
