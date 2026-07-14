import { workerData } from "node:worker_threads";
import { createSimulationTaskRunner } from "./simulation-task-runner.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "./worker-contract.js";
import { UuidBattleIdGenerator } from "../identity/uuid-battle-id-generator.js";
import { SystemRandomSourceFactory } from "../random/system-random-source.js";
import { loadCatalogFromDirectory } from "../catalog/runtime/catalog-file-loader.js";

/**
 * `11_インフラストラクチャ設計.md`「ワーカー初期化」: Piscinaがこのモジュールを
 * Worker Threadとしてロードした時点（最初のタスク受入前）で一度だけCatalogを
 * 読み込み、不変な`InMemoryBattleCatalog`とApplication/Domain依存を組み立てる。
 * Catalog不整合はここで例外として送出され、そのWorkerはReady状態にならない
 * （`SimulationWorkerPool.create`側でWorker起動失敗として扱われる）。
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

const runSimulationTask = createSimulationTaskRunner(catalog, {
  battleIdGenerator: new UuidBattleIdGenerator(),
  randomSourceFactory: new SystemRandomSourceFactory(),
});

/**
 * `11_インフラストラクチャ設計.md`「Catalogリビジョンの一致」: 稼働中に
 * リビジョン不一致が発覚したタスクは拒否した上で、このWorkerを再初期化させる
 * （`process.exit`は`worker_threads`内ではこのスレッドだけを終了させる）。
 * `setImmediate`で1tick遅らせ、Piscinaが現在のタスクの応答を送信し終えて
 * から終了させる — 呼び出し元は正しい`INVALID_DEFINITION`を受け取り、
 * Poolは新しいWorker（再度ディスクからCatalogを読み直す）を補充する。
 * `simulation-task-runner.ts`自体はメインスレッドの単体テストからも
 * 呼ばれるため、`process.exit`はこのWorker専用の薄い接続層にだけ置く。
 *
 * Piscinaの既定`atomics: 'sync'`（`SharedArrayBuffer`+`Atomics.wait`による
 * 低遅延経路）では、応答送信直後にWorkerが自ら終了すると、その終了が
 * どのタスクにも紐づかない未処理の`error`イベントとしてプロセス全体を
 * クラッシュさせることを確認した。`SimulationWorkerPool`側で
 * `atomics: 'disabled'`を指定し、通常の非同期メッセージ経路を使うことで
 * この問題を避けている（詳細は`simulation-worker-pool.ts`）。
 */
export default function handleSimulationTask(task: WorkerSimulationTask): WorkerSimulationResult {
  const outcome = runSimulationTask(task);
  if (!outcome.ok && outcome.error.code === "INVALID_DEFINITION") {
    setImmediate(() => process.exit(1));
  }
  return outcome;
}
