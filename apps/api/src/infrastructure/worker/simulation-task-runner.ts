import { randomUUID } from "node:crypto";
import {
  toSerializedApplicationError,
  type WorkerSimulationResult,
  type WorkerSimulationTask,
} from "./worker-contract.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import { toSimulateTacticalExerciseCommand } from "../../application/simulation/simulate-tactical-exercise-request-mapper.js";
import { SimulateTacticalExerciseUseCase } from "../../application/simulation/simulate-tactical-exercise-use-case.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";
import type { Clock } from "../../domain/ports/clock.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import type { InMemoryBattleCatalog } from "../catalog/runtime/in-memory-battle-catalog.js";

export interface SimulationTaskRunnerDependencies {
  readonly battleIdGenerator: BattleIdGenerator;
  readonly randomSourceFactory: RandomSourceFactory;
  readonly clock: Clock;
}

export type SimulationTaskRunner = (task: WorkerSimulationTask) => WorkerSimulationResult;

/**
 * `11_インフラストラクチャ設計.md`「ワーカースレッドの責務」を1関数へ束ねる:
 * Catalogリビジョン確認 → DTO→Command変換 → `SimulateBattleUseCase`実行 →
 * `WorkerSimulationResult`への変換。Worker初期化時に一度だけ生成され、以後の
 * タスクはこの関数を呼ぶだけで、Catalogやスレッド固有の依存を毎回組み立て
 * 直さない。`workerData`（`node:worker_threads`）へ直接依存しないため、
 * メインスレッドからも単体テストできる。
 */
export function createSimulationTaskRunner(
  catalog: InMemoryBattleCatalog,
  dependencies: SimulationTaskRunnerDependencies,
): SimulationTaskRunner {
  const useCaseDependencies = {
    battleCatalog: catalog,
    battleIdGenerator: dependencies.battleIdGenerator,
    randomSourceFactory: dependencies.randomSourceFactory,
    clock: dependencies.clock,
  };
  const useCase = new SimulateBattleUseCase(useCaseDependencies);
  const tacticalExerciseUseCase = new SimulateTacticalExerciseUseCase(useCaseDependencies);

  return function runSimulationTask(task: WorkerSimulationTask): WorkerSimulationResult {
    if (task.expectedCatalogRevision !== catalog.catalogRevision) {
      return {
        ok: false,
        error: {
          code: "INVALID_DEFINITION",
          violations: [
            {
              reason:
                `worker catalogRevision "${catalog.catalogRevision}" does not match ` +
                `expected "${task.expectedCatalogRevision}"`,
            },
          ],
        },
      };
    }

    try {
      // `09_アプリケーション設計.md`「実行境界」: モード判別子でユースケースを
      // 振り分ける。Catalogリビジョン検査・期限・容量制御は上で共有済み。
      const context = { requestId: task.requestId, deadlineEpochMs: task.deadlineEpochMs };
      if (task.mode === "TACTICAL_EXERCISE") {
        return {
          ok: true,
          mode: "TACTICAL_EXERCISE",
          result: tacticalExerciseUseCase.execute(
            toSimulateTacticalExerciseCommand(task.request),
            context,
          ),
        };
      }
      return {
        ok: true,
        mode: "BATTLE_SIMULATION",
        result: useCase.execute(toSimulateBattleCommand(task.request), context),
      };
    } catch (error) {
      if (error instanceof ApplicationError) {
        return { ok: false, error: toSerializedApplicationError(error) };
      }
      const diagnosticId = randomUUID();
      // `11_インフラストラクチャ設計.md`「予期しない例外の詳細はワーカーログへ記録し、
      // メインスレッドへは診断IDと安全な分類だけを返す」。
      console.error(
        JSON.stringify({
          diagnosticId,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }),
      );
      return {
        ok: false,
        error: {
          code: "INTERNAL_INVARIANT_VIOLATION",
          violations: [{ reason: "An unexpected error occurred while executing the simulation." }],
          diagnosticId,
        },
      };
    }
  };
}
