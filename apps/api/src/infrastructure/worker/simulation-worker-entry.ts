import { workerData } from "node:worker_threads";
import { createSimulationTaskRunner } from "./simulation-task-runner.js";
import { UuidBattleIdGenerator } from "../identity/uuid-battle-id-generator.js";
import { SystemRandomSourceFactory } from "../random/system-random-source.js";
import { Mulberry32SeededRandomSourceProvider } from "../random/seeded-random-source.js";
import { SystemClock } from "../time/system-clock.js";
import { loadCatalogFromDirectory } from "../catalog/runtime/catalog-file-loader.js";
import type { SimulationExecutionLimits } from "../../application/simulation/battle-execution.js";
import type { EvaluationLimits } from "../../application/simulation/evaluate-tactical-exercise-candidates-command.js";

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
 *
 * 稼働中にリビジョン不一致タスクを検出した場合、このWorkerを自ら終了させて
 * 再初期化させることは意図的に行わない。Piscinaは「タスク応答を受信した
 * 時点でWorkerを空き状態にする」ため、応答後に`process.exit`を予約しても、
 * その終了が実際に走る前に次のタスクが同じ（終了予定の）Workerへ割り当てられ
 * `worker exited with code: 1`で失敗する競合を実測で確認した
 * （Piscinaの公開APIには「このタスク限りでWorkerを退役させる」という
 * 安全な手段がない）。
 *
 * Worker単体を安全に再初期化できない以上、稼働中のリビジョン不一致への
 * 対応は`SimulationWorkerPool`（メインスレッド側、単一スレッドなので
 * Workerのような競合が起きない）の責務とする。`SimulationWorkerPool.execute`
 * はリビジョン不一致を観測した時点でPool全体を致命的状態にし、以後の
 * `execute`はこのWorkerへ問い合わせることなく即座に同じエラーで拒否する
 * （詳細は`simulation-worker-pool.ts`と`11_インフラストラクチャ設計.md`
 * 「Catalogリビジョンの一致」）。このモジュール自身は、渡されたタスクの
 * リビジョンを愚直に比較して結果を返すだけでよい。
 */
interface SimulationWorkerData {
  readonly catalogDir: string;
  /** `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」の上限。未指定はコード既定値。 */
  readonly executionLimits?: SimulationExecutionLimits;
  /** 1リクエストが要求できる評価の量（`EVALUATION_*`環境変数）。未指定はコード既定値。 */
  readonly evaluationLimits?: EvaluationLimits;
}

const { catalogDir, executionLimits, evaluationLimits } = workerData as SimulationWorkerData;
const catalog = loadCatalogFromDirectory(catalogDir);

export default createSimulationTaskRunner(catalog, {
  battleIdGenerator: new UuidBattleIdGenerator(),
  randomSourceFactory: new SystemRandomSourceFactory(),
  clock: new SystemClock(),
  seededRandomSourceProvider: new Mulberry32SeededRandomSourceProvider(),
  ...(evaluationLimits !== undefined ? { evaluationLimits } : {}),
  ...(executionLimits !== undefined ? { executionLimits } : {}),
});
