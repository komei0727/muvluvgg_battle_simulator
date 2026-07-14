import { afterEach, describe, expect, it } from "vitest";
import { SimulationWorkerPool } from "./simulation-worker-pool.js";

/**
 * `11_インフラストラクチャ設計.md`「キャンセルと期限」段階2（強制キャンセル）:
 * HTTP切断時、FastifyのAbortSignalをPiscinaタスクへ渡して強制キャンセルする。
 * `__fixtures__/slow-worker.ts`（固定200ms遅延）で「実行中」の窓を作り、その
 * 間に`AbortController.abort()`した場合に、Pool側が`ApplicationError
 * EXECUTION_CANCELLED`へ変換して即座に（200ms待たずに）rejectすることを
 * 検証する。
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

describe("SimulationWorkerPool — cancellation", () => {
  let pool: SimulationWorkerPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it("INT-WORKER-CANCEL-001: execute() rejects with EXECUTION_CANCELLED once the caller's cancellationSignal aborts while the task is in flight, well before the Worker would otherwise have finished", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
    });
    const controller = new AbortController();

    const promise = pool.execute(MINIMAL_REQUEST, {
      requestId: "r1",
      deadlineEpochMs: Date.now() + 30_000,
      cancellationSignal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
  });

  it("INT-WORKER-CANCEL-002: a Worker terminated by cancellation is replaced, so a later execute() still succeeds (cancelling one task does not poison the Pool)", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
    });
    const controller = new AbortController();

    const cancelled = pool.execute(MINIMAL_REQUEST, {
      requestId: "r1",
      deadlineEpochMs: Date.now() + 30_000,
      cancellationSignal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });

    await expect(
      pool.execute(MINIMAL_REQUEST, { requestId: "r2", deadlineEpochMs: Date.now() + 30_000 }),
    ).resolves.toBeDefined();
  });
});
