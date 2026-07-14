import { randomUUID } from "node:crypto";
import { Piscina } from "piscina";
import { toApplicationError } from "./worker-contract.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "./worker-contract.js";
import type { BattleSimulationRequestBody } from "../../application/http-contract.js";
import type { SimulateBattleResult } from "../../application/simulation-result-assembler.js";

export interface SimulationWorkerPoolOptions {
  readonly catalogDir: string;
  readonly catalogRevision: string;
  readonly minThreads?: number;
  readonly maxThreads?: number;
  readonly maxQueue?: number;
  /** テスト・結合テストが明示的なworker entryファイルを指すためのfallback。省略時は同ディレクトリの`simulation-worker-entry`。 */
  readonly workerFileUrl?: URL;
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

// `SIMULATION_TIMEOUT_MS`による実際の期限強制・切断キャンセルは`#18`の範囲。
// ここではWorkerSimulationTaskの契約を満たすためだけの暫定値を設定する。
const PROVISIONAL_TASK_DEADLINE_MS = 30_000;

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
 */
export class SimulationWorkerPool {
  private readonly pool: Piscina<WorkerSimulationTask, WorkerSimulationResult>;
  private readonly catalogRevision: string;

  private constructor(options: SimulationWorkerPoolOptions) {
    this.catalogRevision = options.catalogRevision;
    this.pool = new Piscina<WorkerSimulationTask, WorkerSimulationResult>({
      filename: (options.workerFileUrl ?? resolveDefaultWorkerFileUrl()).href,
      workerData: { catalogDir: options.catalogDir },
      // Piscinaの既定`atomics: 'sync'`は`SharedArrayBuffer`+`Atomics.wait`による
      // 低遅延経路だが、タスク応答直後にWorkerが自ら終了する経路（Catalog
      // リビジョン不一致時の再初期化、`simulation-worker-entry.ts`参照）と
      // 相性が悪く、応答済みタスクの終了が未処理の`error`イベントとして
      // プロセス全体をクラッシュさせることを確認した。通常のメッセージ
      // 経路（`disabled`）はBattle実行時間に比べて無視できるレイテンシ増で
      // 済むため、正しさを優先してここを固定する。
      atomics: "disabled",
      ...(options.minThreads !== undefined ? { minThreads: options.minThreads } : {}),
      ...(options.maxThreads !== undefined ? { maxThreads: options.maxThreads } : {}),
      ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
    });
    // `11_インフラストラクチャ設計.md`「ワーカー障害」: 個々のタスクに紐づかない
    // Worker Threadの異常（例: idle中のクラッシュ）を、プロセス全体を落とす
    // 未処理の`error`イベントにしない。Piscina自身が異常Workerを破棄し
    // 新しいWorkerを補充する。
    this.pool.on("error", (error: unknown) => {
      console.error("SimulationWorkerPool: unhandled Worker Thread error", error);
    });
  }

  /**
   * `warmUpCount`（既定は`minThreads`、最低1）本のwarm-upタスクを実行し、Worker側の
   * Catalog読み込み・検証が成功したこと（モジュール評価が例外なく完了し、
   * `expectedCatalogRevision`が一致すること）を確認してから解決する。
   * Catalogが不正であれば`pool.run`自体が例外で拒否され、リビジョンが
   * 一致しなければ`ok:false`の`INVALID_DEFINITION`が返る — いずれの場合も
   * `create`は失敗し、呼び出し側はHTTPポートを一切公開せずに起動を中断できる。
   */
  static async create(options: SimulationWorkerPoolOptions): Promise<SimulationWorkerPool> {
    const pool = new SimulationWorkerPool(options);
    const warmUpCount = Math.max(options.minThreads ?? 1, 1);
    const warmUpTask: WorkerSimulationTask = {
      requestId: "warmup",
      request: WARM_UP_REQUEST,
      deadlineEpochMs: Date.now() + PROVISIONAL_TASK_DEADLINE_MS,
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

  async execute(request: BattleSimulationRequestBody): Promise<SimulateBattleResult> {
    const task: WorkerSimulationTask = {
      requestId: randomUUID(),
      request,
      deadlineEpochMs: Date.now() + PROVISIONAL_TASK_DEADLINE_MS,
      expectedCatalogRevision: this.catalogRevision,
    };
    const outcome = await this.pool.run(task);
    if (outcome.ok) {
      return outcome.result;
    }
    throw toApplicationError(outcome.error);
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }
}
