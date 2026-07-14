/**
 * `11_インフラストラクチャ設計.md`「ヘルスチェック」`/health/ready`
 * 「連続ワーカー障害によるサーキット状態でない」（レビュー指摘: `pool.on("error")`
 * がログ出力だけで、readinessへ一切反映されていなかった）。
 *
 * Piscinaは個々のタスクに紐づかないWorker Threadの異常（idle中のクラッシュ
 * など）を`pool`の`error`イベントとして通知し、自身で異常Workerを破棄・
 * 補充する（`simulation-worker-pool.ts`参照）。1回だけなら補充で復旧できるが、
 * 起動と異常終了を繰り返すような状態（例: OOMになりやすい環境、壊れた
 * Node.jsランタイム）では補充そのものが無意味になる。連続してこのイベントを
 * 観測した場合にだけサーキットを開き、成功したタスクが1件でもあれば
 * サーキットを閉じる——1回の孤立した異常でreadinessを落とさない。
 */
export class WorkerErrorCircuitBreaker {
  private readonly threshold: number;
  private consecutiveErrors = 0;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  recordError(): void {
    this.consecutiveErrors += 1;
  }

  recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  isOpen(): boolean {
    return this.consecutiveErrors >= this.threshold;
  }
}
