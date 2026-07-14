/**
 * `11_インフラストラクチャ設計.md`「ヘルスチェック」`/health/ready`
 * 「連続ワーカー障害によるサーキット状態でない」（レビュー指摘: `pool.on("error")`
 * がログ出力だけで、readinessへ一切反映されていなかった）。
 *
 * Piscinaが通知するWorker Threadの異常は2経路ある（`simulation-worker-pool.ts`
 * 参照）。個々のタスクに紐づかない異常（idle中のクラッシュなど）は`pool`の
 * `error`イベントとして、実行中タスクを抱えたWorkerの異常は該当タスクの
 * `pool.run()`自体のrejectとして届く——どちらもPiscina自身が異常Workerを
 * 破棄・補充する点は同じ（PRレビュー指摘: 当初は`error`イベント経路しか
 * `recordError`へ接続していなかった）。1回だけなら補充で復旧できるが、
 * 起動と異常終了を繰り返すような状態（例: OOMになりやすい環境、壊れた
 * Node.jsランタイム）では補充そのものが無意味になる。連続してどちらかの
 * 経路で異常を観測した場合にだけサーキットを開き、Workerが応答した
 * タスクが1件でもあれば（業務エラーとして`ok:false`を返した場合を含む）
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
