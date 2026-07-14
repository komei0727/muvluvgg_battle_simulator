import type { SimulateBattleResult } from "../../../application/simulation-result-assembler.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "../worker-contract.js";

/**
 * `simulation-worker-pool-crash-circuit.integration.test.ts`専用のテスト用
 * Piscina worker entry。実Catalog・実Battleを一切使わず、実行中タスクを
 * 抱えたWorker Threadの異常終了だけを決定的に再現する。
 *
 * `requestId: "warmup"`（`SimulationWorkerPool.create`のwarm-upタスクだけが
 * 使う値）には常に成功を返す——`create()`自体が失敗するとPoolを一切得られず、
 * `execute()`側の異常経路を検証できない。それ以外（実際の`execute`呼び出し）
 * では`process.exit(1)`でWorker Thread自身を即座に終了させる。Piscinaは
 * これを実行中タスクの異常終了として扱い、`pool.run()`を`Error('worker
 * exited with code: 1')`でrejectする（`pool`の`error`イベントは発火しない
 * ——`worker-error-circuit-breaker.ts`のコメント参照）。
 */
const FAKE_RESULT = {} as SimulateBattleResult;

export default function crashingWorkerHandler(task: WorkerSimulationTask): WorkerSimulationResult {
  if (task.requestId === "warmup") {
    return { ok: true, result: FAKE_RESULT };
  }
  process.exit(1);
}
