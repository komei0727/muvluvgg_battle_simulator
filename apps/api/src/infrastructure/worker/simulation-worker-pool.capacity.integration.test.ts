import { afterEach, describe, expect, it } from "vitest";
import { SimulationCapacityExceededError } from "../../application/simulation/simulation-capacity-exceeded-error.js";
import { SimulationWorkerPool } from "./simulation-worker-pool.js";

/**
 * `11_インフラストラクチャ設計.md`「プール設定」: 待機キューを無制限にせず、
 * 満杯の場合はタスクを投入せず`503 CAPACITY_EXCEEDED`を返す。実Catalog・
 * 実Battleでは「Workerが埋まっている」状態を安定して起こしにくい（最小戦闘
 * は速すぎる）ため、`__fixtures__/slow-worker.ts`（固定200ms遅延）へ差し替え、
 * `maxThreads: 1, maxQueue: 1`という極小容量でPool側のキュー満杯判定だけを
 * 直接検証する。
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

describe("SimulationWorkerPool — queue capacity", () => {
  let pool: SimulationWorkerPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it("INT-WORKER-CAPACITY-001 (11_インフラストラクチャ設計.md「待機キューを無制限にしない」): rejects with SimulationCapacityExceededError, not a hung task, once the queue is full while a Worker is still busy", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
      maxQueue: 1,
    });

    // 1st task occupies the only Worker; 2nd fills the 1-slot queue.
    const running = pool.execute(MINIMAL_REQUEST, freshContext("r1"));
    const queued = pool.execute(MINIMAL_REQUEST, freshContext("r2"));

    // 3rd overflows: rejected immediately, without waiting for either of the
    // above to finish (proving the Pool doesn't wait for capacity to free up).
    await expect(pool.execute(MINIMAL_REQUEST, freshContext("r3"))).rejects.toBeInstanceOf(
      SimulationCapacityExceededError,
    );

    // Let the in-flight tasks drain so afterEach's close() doesn't need to
    // force-terminate live tasks.
    await Promise.all([running, queued]);
  });

  it("INT-WORKER-CAPACITY-002: once capacity frees up, a subsequent execute() succeeds normally (the Pool itself is not poisoned by a capacity rejection)", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
      maxQueue: 1,
    });

    const running = pool.execute(MINIMAL_REQUEST, freshContext("r1"));
    const queued = pool.execute(MINIMAL_REQUEST, freshContext("r2"));
    await expect(pool.execute(MINIMAL_REQUEST, freshContext("r3"))).rejects.toBeInstanceOf(
      SimulationCapacityExceededError,
    );
    await Promise.all([running, queued]);

    await expect(pool.execute(MINIMAL_REQUEST, freshContext("r4"))).resolves.toBeDefined();
  });
});
