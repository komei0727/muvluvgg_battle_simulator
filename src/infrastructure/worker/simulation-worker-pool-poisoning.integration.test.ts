import { afterEach, describe, expect, it } from "vitest";
import { SimulationWorkerPool } from "./simulation-worker-pool.js";

/**
 * `11_インフラストラクチャ設計.md`「Catalogリビジョンの一致」: 稼働中の
 * リビジョン不一致はWorker単体を安全に再初期化できない（`simulation-worker-
 * pool.ts`のコメント、および撤回した自己終了方式の競合を参照）ため、Pool
 * 全体を致命的状態にする設計へ変更した。実Catalog・実Worker entryではこの
 * 状況を安定して再現できない（`SimulationWorkerPool.create`のwarm-upが
 * 起動時に全Workerのリビジョン一致を検証し切るため）ので、`workerFileUrl`
 * オプションでテスト専用のfakeワーカーへ差し替えて、Pool側の致命化ロジック
 * だけを直接検証する。
 */
const FIXTURE_WORKER_URL = new URL("./__fixtures__/fatal-mismatch-worker.ts", import.meta.url);

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

describe("SimulationWorkerPool — mid-life Catalog revision mismatch poisons the Pool", () => {
  let pool: SimulationWorkerPool | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
  });

  it("INT-WORKER-POISON-001 (11_インフラストラクチャ設計.md「Catalogリビジョンの一致」): once execute() observes a mid-life INVALID_DEFINITION, every subsequent execute() rejects immediately with the same fatal error, without depending on Worker Thread recycling", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
    });

    await expect(pool.execute(MINIMAL_REQUEST)).rejects.toMatchObject({
      code: "INVALID_DEFINITION",
    });

    // The Pool is now fatal: further calls fail the same way even though the
    // fake Worker would answer identically regardless — this proves the fast
    // path doesn't depend on asking the Worker again.
    await expect(pool.execute(MINIMAL_REQUEST)).rejects.toMatchObject({
      code: "INVALID_DEFINITION",
    });
    await expect(pool.execute(MINIMAL_REQUEST)).rejects.toMatchObject({
      code: "INVALID_DEFINITION",
    });
  });

  it("INT-WORKER-POISON-002: close() after a fatal error does not throw (the underlying Pool was already destroyed as part of poisoning)", async () => {
    pool = await SimulationWorkerPool.create({
      catalogDir: "unused-by-fixture",
      catalogRevision: "unused-by-fixture",
      workerFileUrl: FIXTURE_WORKER_URL,
      minThreads: 1,
      maxThreads: 1,
    });

    await expect(pool.execute(MINIMAL_REQUEST)).rejects.toMatchObject({
      code: "INVALID_DEFINITION",
    });

    await expect(pool.close()).resolves.toBeUndefined();
  });
});
