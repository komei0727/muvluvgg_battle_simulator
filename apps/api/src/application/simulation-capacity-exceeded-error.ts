/**
 * `11_インフラストラクチャ設計.md`「エラー処理」: `ワーカープール満杯 → 503
 * CAPACITY_EXCEEDED`は、Fastifyの本文上限やContent-Type違反と同じ並びで
 * リストされる「Fastify境界で発生する構造的エラー」であり、`09_アプリケーション
 * 設計.md`のエラー分類9件（`ApplicationErrorCode`）には含まれない —
 * UseCase／Workerへ一度も到達せず、タスク投入前にメインスレッドの
 * `SimulationWorkerPool`だけで完結して判明するため。`ApplicationError`とは
 * 別の型として表現し、Inbound Adapter（`build-server.ts`）がFastify組み込み
 * エラーと同様に直接マッピングする。
 */
export class SimulationCapacityExceededError extends Error {
  constructor() {
    super("Worker Pool queue is at capacity");
    this.name = "SimulationCapacityExceededError";
  }
}
