import { afterEach, describe, expect, it } from "vitest";
import { SimulationWorkerPool } from "./simulation-worker-pool.js";

/**
 * PRレビュー指摘: `SimulationWorkerPool`はPoolの`error`イベントだけを
 * `WorkerErrorCircuitBreaker`へ接続していたが、Piscinaは実行中タスクを
 * 抱えたWorkerの異常終了を`error`イベントではなく`pool.run()`のrejectとして
 * 通知する（`worker-error-circuit-breaker.ts`のコメント、`crashing-worker.ts`
 * 参照）。実Piscina Workerを繰り返しクラッシュさせ、`isHealthy`が実際に
 * `false`へ倒れることを検証する。
 */
const FIXTURE_WORKER_URL = new URL("./__fixtures__/crashing-worker.ts", import.meta.url);

const MINIMAL_REQUEST = {
  allyFormation: {
    units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  enemyFormation: {
    units: [{ unitDefinitionId: "UNIT_001", position: { column: 0, row: "FRONT" } }],
    memoryDefinitionIds: [],
  },
  turnLimit: 3,
};

function freshContext(requestId: string) {
  return { requestId, deadlineEpochMs: Date.now() + 30_000 };
}

describe("SimulationWorkerPool — consecutive in-flight Worker Thread crashes open the circuit breaker", () => {
  let pool: SimulationWorkerPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it("INT-WORKER-CRASH-001 (11_インフラストラクチャ設計.md「連続ワーカー障害によるサーキット状態でない」): three consecutive in-flight Worker crashes flip isHealthy to false, and each crash still surfaces as a rejected execute() call (not a hung request)", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
    });

    expect(pool.isHealthy).toBe(true);

    await expect(pool.execute(MINIMAL_REQUEST, freshContext("crash-1"))).rejects.toBeTruthy();
    expect(pool.isHealthy).toBe(true);

    await expect(pool.execute(MINIMAL_REQUEST, freshContext("crash-2"))).rejects.toBeTruthy();
    expect(pool.isHealthy).toBe(true);

    await expect(pool.execute(MINIMAL_REQUEST, freshContext("crash-3"))).rejects.toBeTruthy();
    expect(pool.isHealthy).toBe(false);
  }, 30_000);
});
