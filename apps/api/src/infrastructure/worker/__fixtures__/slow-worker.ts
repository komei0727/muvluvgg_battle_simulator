import { setTimeout as delay } from "node:timers/promises";
import type { SimulateBattleResult } from "../../../application/simulation/simulation-result-assembler.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "../worker-contract.js";

/**
 * `simulation-worker-pool-capacity.integration.test.ts` /
 * `simulation-worker-pool-cancellation.integration.test.ts` 専用のテスト用
 * Piscina worker entry。実Catalog・実Battleを一切使わず、常に一定時間
 * 応答を遅らせてから成功を返す — Pool側のキュー満杯検出（`maxQueue`超過で
 * タスクを投入しない）とキャンセル伝播（`AbortSignal`でWorkerが強制終了
 * される）を、実Battleの実行時間に依存せず決定的に検証するための固定遅延。
 */
const FAKE_RESULT = {} as SimulateBattleResult;
const RESPONSE_DELAY_MS = 200;

export default async function slowWorkerHandler(
  _task: WorkerSimulationTask,
): Promise<WorkerSimulationResult> {
  await delay(RESPONSE_DELAY_MS);
  return { ok: true, result: FAKE_RESULT };
}
