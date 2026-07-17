import type { SimulateBattleResult } from "../../../application/simulation/simulation-result-assembler.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "../worker-contract.js";

/**
 * `simulation-worker-pool-crash-circuit.integration.test.ts`専用のテスト用
 * Piscina worker entry。`crashing-worker.ts`と異なり、`requestId`によって
 * 「実行中タスクを抱えたままクラッシュする」か「クラッシュせず`ok:false`の
 * 業務エラーを正常応答として返す」かを切り替えられる——PRレビュー指摘:
 * `ok:false`はWorker基盤としては成功であり`recordSuccess()`でサーキットの
 * 記録をリセットすべき、という挙動を実Worker Threadで検証するために使う。
 *
 * `requestId: "warmup"`には常に成功を、`recover-`で始まる`requestId`には
 * クラッシュせず`ok:false`を、それ以外は`process.exit(1)`で即座に終了する。
 */
const FAKE_RESULT = {} as SimulateBattleResult;

export default function crashingWorkerWithRecoveryHandler(
  task: WorkerSimulationTask,
): WorkerSimulationResult {
  if (task.requestId === "warmup") {
    return { ok: true, result: FAKE_RESULT };
  }
  if (task.requestId.startsWith("recover-")) {
    return {
      ok: false,
      error: {
        code: "INVALID_COMMAND",
        violations: [{ reason: "simulated recoverable business error (test fixture)" }],
      },
    };
  }
  process.exit(1);
}
