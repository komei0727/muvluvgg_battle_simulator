import type { SimulationWorkerPool } from "../infrastructure/worker/simulation-worker-pool.js";

/**
 * `11_インフラストラクチャ設計.md`「Graceful Shutdown」ステップ1「readinessを
 * 失敗へ変更する」の状態そのもの。`presentation/http/build-server.ts`の
 * `ReadinessPort`/`ShutdownGatePort`はどちらも`isReady()`/`isShuttingDown()`
 * という最小形の構造的部分型であり、このクラスのインスタンスをそのまま
 * どちらへも渡せる（`bootstrap/index.ts`参照）。
 */
export class ShutdownState {
  #shuttingDown = false;

  isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  markShuttingDown(): void {
    this.#shuttingDown = true;
  }
}

/**
 * `FastifyInstance`丸ごとではなく、実際に使う形だけを要求する。
 * `close`はFastifyの実シグネチャ（引数なしで呼べば`Promise<undefined>`を
 * 返すoverload）と構造的に両立し、`log`もFastifyの`FastifyBaseLogger`
 * （`info`/`error`以外に`child`/`trace`等を要求する）を渡してそのまま満たせる
 * ——テストでは最小限のfakeだけを用意すればよい。
 */
export interface GracefulShutdownDeps {
  readonly app: {
    close(): Promise<unknown>;
    readonly log: {
      info(...args: unknown[]): void;
      error(...args: unknown[]): void;
    };
  };
  readonly pool: Pick<SimulationWorkerPool, "shutdown">;
  readonly shutdownState: ShutdownState;
}

/**
 * `11_インフラストラクチャ設計.md`「Graceful Shutdown」のステップ1-8。
 *
 * ステップ1（readiness失敗）は`shutdownState.markShuttingDown()`を最初の
 * 同期処理として行う——呼び出し側は返り値を`await`する前でも
 * `shutdownState.isShuttingDown()`で観測できる。ステップ2（新規リクエスト
 * 拒否）は`build-server.ts`のPOSTハンドラーが同じ`shutdownState`を見て
 * 自律的に行うため、ここでは何もしない。
 *
 * ステップ3（HTTP keep-alive drain）とステップ4-7（未開始タスクの即時
 * キャンセル・実行中タスクをgrace期間まで待つ・期限後の強制キャンセル・
 * Pool close）は`Promise.all`で同時に開始する。`app.close()`は応答未送信の
 * in-flightリクエストの完了を待つが、それらのハンドラーは`pool.execute()`
 * （実体は`SimulationWorkerPool`）の結果を待っているため、`pool.shutdown()`が
 * grace期限内の正常完了または期限後の強制キャンセルでそれぞれのタスクを
 * 解決させれば、対応するHTTPハンドラーも完了し、`app.close()`のdrainは
 * 自然に完了する。片方を待ってからもう片方を開始する必要はない。
 *
 * ステップ8（ログ・メトリクスのflush）は、Pinoの既定`stream`（`stdout`
 *相当）は同期的な書き込みで即座にflushされるため、明示的な追加処理を
 * 要しない。
 */
export async function runGracefulShutdown(deps: GracefulShutdownDeps): Promise<void> {
  const { app, pool, shutdownState } = deps;
  shutdownState.markShuttingDown();
  app.log.info("graceful shutdown: readiness failed, draining HTTP connections and Worker Pool");
  await Promise.all([app.close(), pool.shutdown()]);
  app.log.info("graceful shutdown: complete");
}

/**
 * `runGracefulShutdown`をSIGTERM/SIGINTへ配線する薄いグルー。プロセス終了
 * （`process.exit`）を直接呼ぶため、`runGracefulShutdown`自体とは分離して
 * このレイヤーだけをテストで代替する（実際のOSシグナルは送らず、
 * `process.once`をspyして捕捉したハンドラーを直接呼び出す —
 * `shutdown.test.ts`参照）。
 *
 * 返り値のdisposerでリスナーを明示的に外せる。`process.once`はシグナルが
 * 実際に発火すれば自己解除されるが、シグナルが一度も来ないまま
 * （テストで`app.close()`を直接呼ぶ場合や、同一プロセス内で`bootstrap()`を
 * 複数回呼ぶ結合テストなど）このリスナーは残り続ける——`bootstrap/index.ts`
 * が`app`の`onClose`フックからこのdisposerを呼び、Fastifyインスタンスの
 * ライフサイクルへ確実に同期させる。
 */
export function installShutdownSignalHandlers(deps: GracefulShutdownDeps): () => void {
  let handled = false;
  const handleSignal = (): void => {
    if (handled) {
      return;
    }
    handled = true;
    runGracefulShutdown(deps)
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        deps.app.log.error({ err: error }, "graceful shutdown failed");
        process.exit(1);
      });
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);

  return () => {
    process.removeListener("SIGTERM", handleSignal);
    process.removeListener("SIGINT", handleSignal);
  };
}
