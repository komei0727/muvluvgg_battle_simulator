import type { Clock } from "../../domain/ports/clock.js";

/**
 * `11_インフラストラクチャ設計.md`「ワーカー障害」「一定時間内に障害が連続
 * した場合はreadinessを失敗させる」。時刻を持たず正常応答があるまで障害数を
 * 蓄積するだけでは、トラフィックがない状態で1か月に1回ずつidle Worker障害が
 * 起きるような散発的なノイズでも数か月後には「連続3回」に達してサーキットが
 * 開いてしまい、「短時間に集中した障害」と区別できない。
 *
 * Piscinaが通知するWorker Threadの異常は2経路ある（`simulation-worker-pool.ts`
 * 参照）。個々のタスクに紐づかない異常（idle中のクラッシュなど）は`pool`の
 * `error`イベントとして、実行中タスクを抱えたWorkerの異常は該当タスクの
 * `pool.run()`自体のrejectとして届く——どちらもPiscina自身が異常Workerを
 * 破棄・補充する点は同じ。1回だけなら補充で復旧できるが、起動と異常終了を
 * 繰り返すような状態（例: OOMになりやすい環境、壊れたNode.jsランタイム）
 * では補充そのものが無意味になる。`windowMs`以内に`threshold`回の異常を
 * 観測した場合にだけサーキットを開き、Workerが応答したタスクが1件でもあれば
 * （業務エラーとして`ok:false`を返した場合を含む）記録をすべて破棄して
 * サーキットを閉じる——1回の孤立した異常や、時間窓の外に散らばった異常で
 * readinessを落とさない。
 */
export class WorkerErrorCircuitBreaker {
  private readonly clock: Clock;
  private readonly threshold: number;
  private readonly windowMs: number;
  private errorTimestamps: number[] = [];

  constructor(clock: Clock, threshold = 3, windowMs = 60_000) {
    this.clock = clock;
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  recordError(): void {
    this.errorTimestamps.push(this.clock.now());
    this.pruneExpired();
  }

  recordSuccess(): void {
    this.errorTimestamps = [];
  }

  isOpen(): boolean {
    this.pruneExpired();
    return this.errorTimestamps.length >= this.threshold;
  }

  /**
   * `windowMs`より厳密に前（ちょうど`windowMs`前は含む——閉区間
   * `[now - windowMs, now]`）に記録された異常を「時間窓の外」として
   * 切り捨てる。`timestamp > cutoff`だけで判定すると、ちょうど`windowMs`前の
   * 異常が「以内」という説明に反して除外される。
   */
  private pruneExpired(): void {
    const cutoff = this.clock.now() - this.windowMs;
    this.errorTimestamps = this.errorTimestamps.filter((timestamp) => timestamp >= cutoff);
  }
}
