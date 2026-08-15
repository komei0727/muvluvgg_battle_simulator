import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { workerData } from "node:worker_threads";
import { createSimulationTaskRunner } from "../simulation-task-runner.js";
import type { WorkerSimulationResult, WorkerSimulationTask } from "../worker-contract.js";
import { UuidBattleIdGenerator } from "../../identity/uuid-battle-id-generator.js";
import { SystemClock } from "../../time/system-clock.js";
import { loadCatalogFromDirectory } from "../../catalog/runtime/catalog-file-loader.js";
import type { RandomSource } from "../../../domain/ports/random-source.js";
import type { RandomSourceFactory } from "../../../domain/ports/random-source-factory.js";

/**
 * 負荷試験（`__tests__/load/`）専用のPiscina worker entry。`simulation-worker-entry.ts`
 * と同じ組み立て（同じ`createSimulationTaskRunner`・同じCatalogロード・同じ`SystemClock`）
 * を行い、**RandomSourceだけ**を定数ソースへ差し替える。加えて、任意で
 * 「タスクの実行開始」をファイルで通知し、解放されるまで待つlatchを持つ。
 *
 * production の `SystemRandomSourceFactory` のままでは、次の2つが測れない。
 *
 * 1. **最大応答**。決着ターンが試行ごとに変わるため、`LOAD-CAPACITY-003`が定数乱数で
 *    特定した最悪ケース（23.1 MB）をWorker経路で狙って再現できない（実測: 同じ編成を
 *    実経路へ流しても1.2 MB程度にしかならず、最大ケースのメモリーを検証したことに
 *    ならない）。
 * 2. **実行中shutdown**。`execute()`入口のlatchと固定sleepでは、shutdown開始時点で
 *    タスクがまだ実行中である保証がない（実測: `shutdownMs`は1.5msで、実際には
 *    Workerが戦闘を始める前に閉じていた可能性を排除できない）。
 *
 * Graceful Shutdown・容量制御・構造化クローン・HTTP直列化といった測定対象の機構は
 * production とまったく同じ経路を通る。差し替えているのは乱数と、明示的に
 * `latched-` で始まる`requestId`を持つタスクの開始タイミングだけである。
 */
interface DeterministicWorkerData {
  readonly catalogDir: string;
}

/** 定数RandomSource。`testing/scenario/run-production-battle.ts`と同じ決定化手段。 */
class ConstantRandomSourceFactory implements RandomSourceFactory {
  private readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  create(): RandomSource {
    const value = this.value;
    return { next: () => value };
  }
}

/**
 * Worker Threadは生成時点の`process.env`のコピーを受け取る（Piscinaは`SHARE_ENV`を
 * 使わない）。`SharedArrayBuffer`をPoolの`workerData`へ載せる手段が
 * `SimulationWorkerPool`には無いため、fixtureの設定は環境変数で渡す。
 */
const RANDOM_VALUE = Number(process.env["LOAD_FIXTURE_RANDOM_VALUE"] ?? "0.5");
const STARTED_PATH = process.env["LOAD_FIXTURE_STARTED_PATH"];
const RELEASE_PATH = process.env["LOAD_FIXTURE_RELEASE_PATH"];

/** このprefixを持つ`requestId`のタスクだけがlatchで待たされる（warm-upは素通しする）。 */
const LATCHED_REQUEST_ID_PREFIX = "latched-";

const { catalogDir } = workerData as DeterministicWorkerData;
const catalog = loadCatalogFromDirectory(catalogDir);

const runTask = createSimulationTaskRunner(catalog, {
  battleIdGenerator: new UuidBattleIdGenerator(),
  randomSourceFactory: new ConstantRandomSourceFactory(RANDOM_VALUE),
  clock: new SystemClock(),
});

export default async function deterministicBattleWorker(
  task: WorkerSimulationTask,
): Promise<WorkerSimulationResult> {
  if (
    task.requestId.startsWith(LATCHED_REQUEST_ID_PREFIX) &&
    STARTED_PATH !== undefined &&
    RELEASE_PATH !== undefined
  ) {
    // Piscinaはこのhandlerを呼んだ時点でタスクを「実行中」として扱う。開始を
    // 通知してから解放を待つことで、呼び出し側は「実行中でありまだ完了していない」
    // 状態を確実に観測してからshutdownを開始できる。
    writeFileSync(STARTED_PATH, "1");
    while (!existsSync(RELEASE_PATH)) {
      await delay(5);
    }
  }
  return runTask(task);
}
