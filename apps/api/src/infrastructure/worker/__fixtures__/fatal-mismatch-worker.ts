import type { SimulateBattleResult } from "../../../application/simulation/simulation-result-assembler.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "../worker-contract.js";

/**
 * `simulation-worker-pool.integration.test.ts`専用のテスト用Piscina worker
 * entry。実Catalog・実Battleを一切使わず、`SimulationWorkerPool`の
 * Catalogリビジョン不一致検出時のPool致命化ロジックだけを検証する。
 *
 * `requestId: "warmup"`（`SimulationWorkerPool.create`のwarm-upタスクだけが
 * 使う値）には常に成功を返し、それ以外（実際の`execute`呼び出し）には
 * 常にリビジョン不一致を返す。型のみのimportだけで完結するため、`tsc`
 * ビルドなしでも（`.js`拡張子への解決が不要なため）実Worker Threadとして
 * そのまま起動できる。
 */
const FAKE_RESULT = {} as SimulateBattleResult;

export default function fakeWorkerHandler(task: WorkerSimulationTask): WorkerSimulationResult {
  if (task.requestId === "warmup") {
    return { ok: true, result: FAKE_RESULT };
  }
  return {
    ok: false,
    error: {
      code: "INVALID_DEFINITION",
      violations: [{ reason: "simulated mid-life Catalog revision mismatch (test fixture)" }],
    },
  };
}
