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

/**
 * `11_インフラストラクチャ設計.md`「ワーカープール設計」のPiscina実装。
 * `execute`はDTOを受け取り、`WorkerSimulationTask`へ包んでWorker Threadへ
 * 投入する — DTO→Command変換とBattle実行はWorker側（`simulation-worker-entry.ts`）
 * だけが行い、メインスレッドではBattleを直接実行しない。
 */
export class SimulationWorkerPool {
  private readonly pool: Piscina<WorkerSimulationTask, WorkerSimulationResult>;
  private readonly catalogRevision: string;

  constructor(options: SimulationWorkerPoolOptions) {
    this.catalogRevision = options.catalogRevision;
    this.pool = new Piscina<WorkerSimulationTask, WorkerSimulationResult>({
      filename: (options.workerFileUrl ?? resolveDefaultWorkerFileUrl()).href,
      workerData: { catalogDir: options.catalogDir },
      ...(options.minThreads !== undefined ? { minThreads: options.minThreads } : {}),
      ...(options.maxThreads !== undefined ? { maxThreads: options.maxThreads } : {}),
      ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
    });
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
