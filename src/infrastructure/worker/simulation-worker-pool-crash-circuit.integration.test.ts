import { afterEach, describe, expect, it } from "vitest";
import { SimulationWorkerPool } from "./simulation-worker-pool.js";

/**
 * PRレビュー指摘: `SimulationWorkerPool`はPoolの`error`イベントだけを
 * `WorkerErrorCircuitBreaker`へ接続していたが、Piscinaは実行中タスクを
 * 抱えたWorkerの異常終了を`error`イベントではなく`pool.run()`のrejectとして
 * 通知する（`worker-error-circuit-breaker.ts`のコメント、`crashing-worker.ts`
 * 参照）。実Piscina Workerを繰り返しクラッシュさせ、`isHealthy`が実際に
 * `false`へ倒れることを検証する。あわせて、`ok:false`の業務エラー応答が
 * サーキットの記録を正しくリセットすることも`crashing-worker-with-recovery.ts`
 * で検証する（PRレビュー指摘: リセット位置の回帰を防ぐテスト）。
 */
const FIXTURE_WORKER_URL = new URL("./__fixtures__/crashing-worker.ts", import.meta.url);
const RECOVERABLE_FIXTURE_WORKER_URL = new URL(
  "./__fixtures__/crashing-worker-with-recovery.ts",
  import.meta.url,
);

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

  it("INT-WORKER-CRASH-002 (PRレビュー指摘: ok:falseの業務エラーもWorker基盤としては成功なので、recordSuccess()の呼び出し位置がoutcome.okの内側だけへ後退していないことを固定する回帰テスト): a non-crashing ok:false response between two pairs of crashes resets the circuit breaker, so two crashes + a recovery + two more crashes never opens it", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: RECOVERABLE_FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
    });

    expect(pool.isHealthy).toBe(true);

    await expect(pool.execute(MINIMAL_REQUEST, freshContext("crash-1"))).rejects.toBeTruthy();
    await expect(pool.execute(MINIMAL_REQUEST, freshContext("crash-2"))).rejects.toBeTruthy();
    expect(pool.isHealthy).toBe(true);

    // Workerはクラッシュせず`ok:false`を正常応答として返す——サーキットの
    // 記録がリセットされる（`outcome.ok`の内側だけでリセットしていた旧実装
    // だと、ここでリセットされずこの後の2回のクラッシュで閾値3に達し、
    // このテストは失敗していたはず）。
    await expect(pool.execute(MINIMAL_REQUEST, freshContext("recover-1"))).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
    expect(pool.isHealthy).toBe(true);

    await expect(pool.execute(MINIMAL_REQUEST, freshContext("crash-3"))).rejects.toBeTruthy();
    await expect(pool.execute(MINIMAL_REQUEST, freshContext("crash-4"))).rejects.toBeTruthy();
    expect(pool.isHealthy).toBe(true);
  }, 30_000);
});
