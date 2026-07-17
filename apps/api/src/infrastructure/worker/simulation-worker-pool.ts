import { Piscina } from "piscina";
import { toApplicationError } from "./worker-contract.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "./worker-contract.js";
import { WorkerErrorCircuitBreaker } from "./worker-error-circuit-breaker.js";
import { SystemClock } from "../time/system-clock.js";
import type { Clock } from "../../domain/ports/clock.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type { BattleSimulationRequestBody } from "../../application/contracts/http-contract.js";
import { SimulationCapacityExceededError } from "../../application/simulation/simulation-capacity-exceeded-error.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import type { SimulateBattleResult } from "../../application/simulation/simulation-result-assembler.js";

export interface SimulationWorkerPoolOptions {
  readonly catalogDir: string;
  readonly catalogRevision: string;
  readonly minThreads?: number;
  readonly maxThreads?: number;
  readonly maxQueue?: number;
  /** テスト・結合テストが明示的なworker entryファイルを指すためのfallback。省略時は同ディレクトリの`simulation-worker-entry`。 */
  readonly workerFileUrl?: URL;
  /** `11_インフラストラクチャ設計.md`「Graceful Shutdown」`shutdown()`が実行中タスクを待つ上限(ms)。省略時はPiscina自身の既定(30000)。 */
  readonly shutdownGraceMs?: number;
  /** `workerErrorCircuitBreaker`の時間窓判定に使う`Clock`。省略時は`SystemClock`（実時間）。テストは`ManualClock`を注入して時間窓を決定的に検証する。 */
  readonly clock?: Clock;
}

/**
 * `13_実装計画.md`「開発時のtsx実行とproductionのコンパイル済み実行で、ワーカーファイル
 * 解決方法が変わる点」への対応。このモジュール自身の`import.meta.url`は、`tsx`/Vitest
 * 実行時は`.ts`のまま、`tsc`ビルド後は`.js`になる。Node.js 24はerasable
 * TypeScriptをネイティブに実行できるため、同じ拡張子の兄弟ファイルを指すだけで
 * 両方のケースが解決できる。
 */
function resolveDefaultWorkerFileUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./simulation-worker-entry${extension}`, import.meta.url);
}

// warm-upタスク専用の期限。実リクエストの`deadlineEpochMs`は`execute`の
// `SimulationExecutionContext`（呼び出し側 — `build-server.ts`が`SIMULATION_
// TIMEOUT_MS`から算出）から受け取るため、この定数は使わない。
const WARM_UP_TASK_DEADLINE_MS = 30_000;

/**
 * Piscinaはキュー満杯を専用の例外型ではなく、固定メッセージの`Error`として
 * `pool.run()`のPromiseをrejectする（`piscina/dist/errors.js`の`Errors`。
 * 型としては公開されていない）。`maxQueue`が正の値のときは`'Task queue is at
 * limit'`、`maxQueue: 0`のときは`'No task queue available and all Workers are
 * busy'`。メッセージ比較でしか判別できないため、両方を許容する。
 */
const QUEUE_FULL_ERROR_MESSAGES = new Set([
  "Task queue is at limit",
  "No task queue available and all Workers are busy",
]);

function isQueueFullError(error: unknown): boolean {
  return error instanceof Error && QUEUE_FULL_ERROR_MESSAGES.has(error.message);
}

/** Piscinaの`AbortError`（`piscina/dist/abort.js`）。`name`ゲッターで判別する。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Piscinaは`close({force:true})`/`destroy()`で強制終了されたWorkerの実行中
 * タスクを、専用の例外型ではなく固定メッセージの`Error`でrejectする
 * （`piscina/dist/errors.js`の`Errors.ThreadTermination`。型としては公開
 * されていない）。`11_インフラストラクチャ設計.md`「Graceful Shutdown」の
 * 強制キャンセル（ステップ4・6）はクライアント切断時の強制キャンセルと同じ
 * `EXECUTION_CANCELLED`として扱うため、`isAbortError`と同様にメッセージで
 * 判別する。
 */
function isPoolTerminatingError(error: unknown): boolean {
  return error instanceof Error && error.message === "Terminating worker thread";
}

/** warm-up専用のダミーDTO。`expectedCatalogRevision`さえ正しければ、Command検証に
 * 落ちて`ok:false`になってもWorkerのCatalog読み込み成功は確認できる。 */
const WARM_UP_REQUEST: BattleSimulationRequestBody = {
  allyFormation: { units: [], memoryDefinitionIds: [] },
  enemyFormation: { units: [], memoryDefinitionIds: [] },
  turnLimit: 1,
};

export class SimulationWorkerPoolStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationWorkerPoolStartupError";
  }
}

/**
 * `11_インフラストラクチャ設計.md`「ワーカープール設計」のPiscina実装。
 * `execute`はDTOを受け取り、`WorkerSimulationTask`へ包んでWorker Threadへ
 * 投入する — DTO→Command変換とBattle実行はWorker側（`simulation-worker-entry.ts`）
 * だけが行い、メインスレッドではBattleを直接実行しない。
 *
 * コンストラクタはprivateにし、`create`だけを公開する。Piscinaは`minThreads`分の
 * Workerをコンストラクタ内で非同期に起動するため、`new`で返った直後は
 * Catalog読み込み・検証が完了している保証がない。`create`はwarm-upタスクを
 * 実際に実行してその完了（またはCatalog不整合による失敗）を待ってから
 * Poolを返すため、呼び出し側（`bootstrap`）は「初期化完了を確認してからlisten」
 * という起動契約を`await`だけで満たせる。
 *
 * `11_インフラストラクチャ設計.md`「Catalogリビジョンの一致」: `catalogDir`は
 * ホットリロード機能こそ提供しないが、稼働中に外部から不正に置換される
 * 可能性自体をランタイムが防いでいるわけではない。稼働中にWorkerが
 * リビジョン不一致を報告した場合、その特定のWorkerだけを安全に退役・再起動
 * する手段はPiscinaの公開APIには存在しない（応答受信と同時にWorkerを空き
 * 扱いにする挙動と競合することを実測で確認済み）。そのためこのPoolは
 * 該当タスクを拒否した時点で全体を致命的状態（`fatalError`）へ遷移させ、
 * 以後の`execute`はWorkerへ問い合わせることなく同じエラーで即座に拒否する。
 * 個々のWorkerを騙し騙し使い続けて一部のリクエストだけが不定期に失敗する
 * より、Pool全体を一貫して失敗させる方が運用上の異常検知・復旧（プロセス
 * 再起動）に直結し安全である。
 */
export class SimulationWorkerPool {
  private readonly pool: Piscina<WorkerSimulationTask, WorkerSimulationResult>;
  private readonly catalogRevision: string;
  private readonly workerErrorCircuitBreaker: WorkerErrorCircuitBreaker;
  private fatalError: ApplicationError | undefined;

  private constructor(options: SimulationWorkerPoolOptions) {
    this.catalogRevision = options.catalogRevision;
    this.workerErrorCircuitBreaker = new WorkerErrorCircuitBreaker(
      options.clock ?? new SystemClock(),
    );
    this.pool = new Piscina<WorkerSimulationTask, WorkerSimulationResult>({
      filename: (options.workerFileUrl ?? resolveDefaultWorkerFileUrl()).href,
      workerData: { catalogDir: options.catalogDir },
      // Piscinaの既定`atomics: 'sync'`（`SharedArrayBuffer`+`Atomics.wait`による
      // 低遅延経路）は、応答送信直後にWorkerが自ら終了するケースで、その終了が
      // どのタスクにも紐づかない未処理の`error`イベントとしてプロセス全体を
      // クラッシュさせることを確認した（`11_インフラストラクチャ設計.md`
      // 「ワーカー障害」がWorkerの予期しない終了そのものを許容している以上、
      // 終了の理由を問わずクラッシュしない経路にしておく）。通常のメッセージ
      // 経路（`disabled`）はBattle実行時間に比べて無視できるレイテンシ増で
      // 済むため、正しさを優先してここを固定する。
      atomics: "disabled",
      ...(options.minThreads !== undefined ? { minThreads: options.minThreads } : {}),
      ...(options.maxThreads !== undefined ? { maxThreads: options.maxThreads } : {}),
      ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
      ...(options.shutdownGraceMs !== undefined ? { closeTimeout: options.shutdownGraceMs } : {}),
    });
    // `11_インフラストラクチャ設計.md`「ワーカー障害」: 個々のタスクに紐づかない
    // Worker Threadの異常（例: idle中のクラッシュ）を、プロセス全体を落とす
    // 未処理の`error`イベントにしない。Piscina自身が異常Workerを破棄し
    // 新しいWorkerを補充する。「/health/ready」「連続ワーカー障害による
    // サーキット状態でない」（レビュー指摘）: 補充を繰り返しても収束しない
    // 連続異常は`workerErrorCircuitBreaker`経由で`isHealthy`へ反映する
    // （`execute`の正常応答パスがカウンターをリセットする）。実行中タスクを
    // 抱えたWorkerの異常はこの`error`イベントではなく`execute`側の
    // `pool.run()` rejectとして届くため、そちらでも同じ`recordError`を呼ぶ
    // （PRレビュー指摘: idle中の異常しかここでは捕捉できない）。
    this.pool.on("error", (error: unknown) => {
      console.error("SimulationWorkerPool: unhandled Worker Thread error", error);
      this.workerErrorCircuitBreaker.recordError();
    });
  }

  /**
   * `pool.minThreads`本（Piscinaが実際に解決した最小Worker数。`options.minThreads`
   * を渡さなかった場合はPiscina自身の既定値が入るため、渡された値ではなく
   * Piscinaが解決した値を使う）分のwarm-upタスクを実行し、Worker側の
   * Catalog読み込み・検証が成功したこと（モジュール評価が例外なく完了し、
   * `expectedCatalogRevision`が一致すること）を確認してから解決する。
   * Catalogが不正であれば`pool.run`自体が例外で拒否され、リビジョンが
   * 一致しなければ`ok:false`の`INVALID_DEFINITION`が返る — いずれの場合も
   * `create`は失敗し、呼び出し側はHTTPポートを一切公開せずに起動を中断できる。
   */
  static async create(options: SimulationWorkerPoolOptions): Promise<SimulationWorkerPool> {
    const pool = new SimulationWorkerPool(options);
    const warmUpCount = Math.max(pool.pool.minThreads, 1);
    const warmUpTask: WorkerSimulationTask = {
      requestId: "warmup",
      request: WARM_UP_REQUEST,
      deadlineEpochMs: Date.now() + WARM_UP_TASK_DEADLINE_MS,
      expectedCatalogRevision: options.catalogRevision,
    };

    let outcomes: readonly WorkerSimulationResult[];
    try {
      outcomes = await Promise.all(
        Array.from({ length: warmUpCount }, () => pool.pool.run(warmUpTask)),
      );
    } catch (error) {
      await pool.close();
      const reason = error instanceof Error ? error.message : String(error);
      throw new SimulationWorkerPoolStartupError(
        `SimulationWorkerPool failed to warm up (Worker Catalog initialization failed): ${reason}`,
      );
    }

    const mismatch = outcomes.find(
      (outcome) => !outcome.ok && outcome.error.code === "INVALID_DEFINITION",
    );
    if (mismatch !== undefined) {
      await pool.close();
      throw new SimulationWorkerPoolStartupError(
        `SimulationWorkerPool failed to warm up: Worker Catalog revision does not match expected "${options.catalogRevision}"`,
      );
    }

    return pool;
  }

  /**
   * `11_インフラストラクチャ設計.md`「ヘルスチェック」`/health/ready`
   * 「ワーカーのCatalogリビジョンが期待値と一致」「連続ワーカー障害による
   * サーキット状態でない」。稼働中のCatalogリビジョン不一致で`fatalError`が
   * 立った場合、または`workerErrorCircuitBreaker`が開いた場合にfalseになる。
   */
  get isHealthy(): boolean {
    return this.fatalError === undefined && !this.workerErrorCircuitBreaker.isOpen();
  }

  async execute(
    request: BattleSimulationRequestBody,
    context: SimulationExecutionContext,
  ): Promise<SimulateBattleResult> {
    if (this.fatalError !== undefined) {
      throw this.fatalError;
    }

    const task: WorkerSimulationTask = {
      requestId: context.requestId,
      request,
      deadlineEpochMs: context.deadlineEpochMs,
      expectedCatalogRevision: this.catalogRevision,
    };

    let outcome: WorkerSimulationResult;
    try {
      outcome = await this.pool.run(task, { signal: context.cancellationSignal ?? null });
    } catch (error) {
      if (isQueueFullError(error)) {
        // `11_インフラストラクチャ設計.md`「待機キューを無制限にしない」:
        // タスクは一度もWorkerへ投入されていない ── Poolそのものは健全なまま。
        throw new SimulationCapacityExceededError();
      }
      if (isAbortError(error) || isPoolTerminatingError(error)) {
        // `11_インフラストラクチャ設計.md`「キャンセルと期限」段階2（強制
        // キャンセル）および「Graceful Shutdown」ステップ4・6（未開始タスクの
        // キャンセル、grace期限後の強制キャンセル）: HTTP切断・AbortSignal・
        // shutdown()による強制終了のいずれも、勝敗結果としては返さず
        // `EXECUTION_CANCELLED`として伝える。
        throw new ApplicationError("EXECUTION_CANCELLED", [
          { reason: "the simulation was cancelled before it completed" },
        ]);
      }
      // PRレビュー指摘: Piscinaはidle中のWorker異常だけを`pool`の`error`
      // イベントで通知する（コンストラクタの`pool.on("error", ...)`参照）。
      // 実行中タスクを抱えたWorkerが異常終了した場合は、そのタスクの
      // `pool.run()`自体がこの`err`でreject される（`error`イベントは
      // 発火しない）。ここへ到達するのは容量超過・キャンセル・shutdown
      // のいずれでもない、実際のWorker Thread異常だけなので、サーキットへ
      // 記録する。
      this.workerErrorCircuitBreaker.recordError();
      throw error;
    }

    // Workerが`WorkerSimulationResult`を返した時点で、`outcome.ok`の真偽に
    // 関わらずWorker基盤自体は正常に応答している（`ok:false`はBattle実行の
    // 業務エラーであり、Worker Threadの異常ではない）。サーキットが開きかけて
    // いてもPoolは機能している証拠として連続エラーカウントをリセットする。
    this.workerErrorCircuitBreaker.recordSuccess();

    if (outcome.ok) {
      return outcome.result;
    }

    const error = toApplicationError(outcome.error);
    if (outcome.error.code === "INVALID_DEFINITION") {
      // `11_インフラストラクチャ設計.md`「Catalogリビジョンの一致」: 稼働中の
      // 不一致は安全に復旧できないため、この時点でPoolを致命的状態にする。
      // 破棄はベストエフォート（すでに致命的なので失敗しても上書きしない）。
      this.fatalError = error;
      this.pool.destroy().catch((destroyError: unknown) => {
        console.error(
          "SimulationWorkerPool: failed to destroy Pool after a fatal error",
          destroyError,
        );
      });
    }
    throw error;
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }

  /**
   * `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ4-7の
   * Pool側部分。Piscinaの`close({force:true})`は、未開始タスク（キュー・
   * skipQueue）を即座にreject（ステップ4）してから、実行中タスクの完了を
   * `closeTimeout`（`shutdownGraceMs`、コンストラクタ参照）まで待ち
   * （ステップ5）、期限が来ても残っていれば`destroy()`で強制終了する
   * （ステップ6）。いずれの経路でも待受側は`execute()`の`isPoolTerminatingError`
   * 判定で`EXECUTION_CANCELLED`を受け取る。`close()`（起動失敗時の即時破棄）
   * とは異なり、実行中タスクへ完了の機会を与える点が違う。
   */
  async shutdown(): Promise<void> {
    await this.pool.close({ force: true });
  }
}
