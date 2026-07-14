import { afterEach, describe, expect, it } from "vitest";
import { SimulationWorkerPool } from "./simulation-worker-pool.js";

/**
 * `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ4-7
 * （未開始タスクのキャンセル、実行中タスクを`SHUTDOWN_GRACE_MS`まで待つ、
 * 期限後の強制キャンセル、Poolのclose）を`SimulationWorkerPool.shutdown()`
 * だけで検証する。`__fixtures__/slow-worker.ts`（固定200ms遅延）を使い、
 * grace期間より短い/長いタスクの挙動を決定的に区別する。
 */
const FIXTURE_WORKER_URL = new URL("./__fixtures__/slow-worker.ts", import.meta.url);

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

describe("SimulationWorkerPool — graceful shutdown", () => {
  let pool: SimulationWorkerPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it("INT-WORKER-SHUTDOWN-001: a queued (not yet started) task is rejected immediately once shutdown() begins, without waiting for it to ever run", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
      maxQueue: 1,
      shutdownGraceMs: 5_000,
    });

    // 1st task occupies the only Worker (200ms); 2nd sits in the queue.
    const running = pool.execute(MINIMAL_REQUEST, freshContext("r1"));
    const queued = pool.execute(MINIMAL_REQUEST, freshContext("r2"));
    // Attach assertions synchronously so a rejection during shutdown() below
    // is never briefly unobserved (Node flags that as an unhandled rejection
    // even when a `.catch`/`await expect(...)` follows a tick later).
    const queuedRejection = expect(queued).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
    // The already-running task still had time to finish inside the 5s grace period.
    const runningResolution = expect(running).resolves.toBeDefined();

    await expect(pool.shutdown()).resolves.toBeUndefined();

    await queuedRejection;
    await runningResolution;
  });

  it("INT-WORKER-SHUTDOWN-002: a running task still in flight when the grace period elapses is force-cancelled as EXECUTION_CANCELLED, not left hanging", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
      shutdownGraceMs: 20, // shorter than the fixture's 200ms fixed delay
    });

    const running = pool.execute(MINIMAL_REQUEST, freshContext("r1"));
    const runningRejection = expect(running).rejects.toMatchObject({
      code: "EXECUTION_CANCELLED",
    });

    await expect(pool.shutdown()).resolves.toBeUndefined();
    await runningRejection;
  });

  it("INT-WORKER-SHUTDOWN-003: shutdown() with no outstanding tasks resolves promptly", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
      shutdownGraceMs: 5_000,
    });

    await expect(pool.shutdown()).resolves.toBeUndefined();
  });
});
