import { randomUUID } from "node:crypto";
import {
  toSerializedApplicationError,
  type WorkerSimulationResult,
  type WorkerSimulationTask,
} from "./worker-contract.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import { toSimulateBattleCommand } from "../../application/simulation/simulate-battle-request-mapper.js";
import { toEvaluateTacticalExercisesCommand } from "../../application/simulation/evaluate-tactical-exercises-mapper.js";
import { EvaluateTacticalExercisesUseCase } from "../../application/simulation/evaluate-tactical-exercises-use-case.js";
import { DEFAULT_TACTICAL_EXERCISE_EVALUATION_LIMITS } from "../../application/simulation/evaluate-tactical-exercises-command.js";
import { DEFAULT_BATTLE_EVALUATION_LIMITS } from "../../application/simulation/evaluate-battles-command.js";
import { toEvaluateBattlesCommand } from "../../application/simulation/evaluate-battles-mapper.js";
import { EvaluateBattlesUseCase } from "../../application/simulation/evaluate-battles-use-case.js";
import { DEFAULT_TOTAL_WAR_EVALUATION_LIMITS } from "../../application/simulation/evaluate-total-wars-command.js";
import { toEvaluateTotalWarsCommand } from "../../application/simulation/evaluate-total-wars-mapper.js";
import { EvaluateTotalWarsUseCase } from "../../application/simulation/evaluate-total-wars-use-case.js";
import type { EvaluationRequestLimits } from "../../application/simulation/evaluation-command.js";
import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import type { SimulationExecutionLimits } from "../../application/simulation/battle-execution.js";
import { toSimulateTacticalExerciseCommand } from "../../application/simulation/simulate-tactical-exercise-request-mapper.js";
import { SimulateTacticalExerciseUseCase } from "../../application/simulation/simulate-tactical-exercise-use-case.js";
import { toSimulateTotalWarCommand } from "../../application/simulation/simulate-total-war-request-mapper.js";
import { SimulateTotalWarUseCase } from "../../application/simulation/simulate-total-war-use-case.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";
import type { Clock } from "../../domain/ports/clock.js";
import type { RandomSourceFactory } from "../../domain/ports/random-source-factory.js";
import type { SeededRandomSourceProvider } from "../../domain/ports/seeded-random-source-provider.js";
import { Mulberry32SeededRandomSourceProvider } from "../random/seeded-random-source.js";
import type { InMemoryBattleCatalog } from "../catalog/runtime/in-memory-battle-catalog.js";

export interface SimulationTaskRunnerDependencies {
  readonly battleIdGenerator: BattleIdGenerator;
  readonly randomSourceFactory: RandomSourceFactory;
  readonly clock: Clock;
  /**
   * `11_インフラストラクチャ設計.md`「SimulationExecutionGuard」「上限値は設定から
   * 受け取る」。Worker側の実行保護上限。省略時は
   * `DEFAULT_SIMULATION_EXECUTION_LIMITS`。
   */
  readonly executionLimits?: SimulationExecutionLimits;
  /** 大量試行が使う、seedと試行番号から決まる乱数源。省略時は`Mulberry32SeededRandomSourceProvider`。 */
  readonly seededRandomSourceProvider?: SeededRandomSourceProvider;
  /** 戦術演習の大量試行の要求量上限。省略時は{@link DEFAULT_TACTICAL_EXERCISE_EVALUATION_LIMITS}。 */
  readonly tacticalExerciseEvaluationLimits?: EvaluationRequestLimits;
  /**
   * 大量試行の応答が載せる戦闘実装の識別情報。起動時に確定させて注入する。省略時は
   * 大量試行を実行しない — 未知の値を固定文字列で返すと、別の実装の結果を同じ条件の
   * ものとして混ぜられてしまう。
   */
  readonly engineRevision?: string;
  /** 通常戦闘の大量試行の要求量上限。省略時は{@link DEFAULT_BATTLE_EVALUATION_LIMITS}。 */
  readonly battleEvaluationLimits?: EvaluationRequestLimits;
  /** 総力戦の大量試行の要求量上限。省略時は{@link DEFAULT_TOTAL_WAR_EVALUATION_LIMITS}。 */
  readonly totalWarEvaluationLimits?: EvaluationRequestLimits;
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
    ...(dependencies.executionLimits !== undefined
      ? { executionLimits: dependencies.executionLimits }
      : {}),
  };
  const useCase = new SimulateBattleUseCase(useCaseDependencies);
  const tacticalExerciseUseCase = new SimulateTacticalExerciseUseCase(useCaseDependencies);
  const totalWarUseCase = new SimulateTotalWarUseCase(useCaseDependencies);
  const seededRandomSourceProvider =
    dependencies.seededRandomSourceProvider ?? new Mulberry32SeededRandomSourceProvider();
  const seededEvaluationDependencies = (engineRevision: string) => ({
    battleCatalog: catalog,
    battleIdGenerator: dependencies.battleIdGenerator,
    clock: dependencies.clock,
    seededRandomSourceProvider,
    runtimeInfo: { engineRevision },
    ...(dependencies.executionLimits !== undefined
      ? { executionLimits: dependencies.executionLimits }
      : {}),
  });
  const engineRevision = dependencies.engineRevision;
  const battleEvaluationUseCase =
    engineRevision === undefined
      ? undefined
      : new EvaluateBattlesUseCase({
          ...seededEvaluationDependencies(engineRevision),
          limits: dependencies.battleEvaluationLimits ?? DEFAULT_BATTLE_EVALUATION_LIMITS,
        });
  const totalWarEvaluationUseCase =
    engineRevision === undefined
      ? undefined
      : new EvaluateTotalWarsUseCase({
          ...seededEvaluationDependencies(engineRevision),
          limits: dependencies.totalWarEvaluationLimits ?? DEFAULT_TOTAL_WAR_EVALUATION_LIMITS,
        });
  const tacticalExerciseEvaluationUseCase =
    engineRevision === undefined
      ? undefined
      : new EvaluateTacticalExercisesUseCase({
          ...seededEvaluationDependencies(engineRevision),
          limits:
            dependencies.tacticalExerciseEvaluationLimits ??
            DEFAULT_TACTICAL_EXERCISE_EVALUATION_LIMITS,
        });

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
      if (
        task.mode === "BATTLE_EVALUATION" ||
        task.mode === "TOTAL_WAR_EVALUATION" ||
        task.mode === "TACTICAL_EXERCISE_EVALUATION"
      ) {
        if (
          battleEvaluationUseCase === undefined ||
          totalWarEvaluationUseCase === undefined ||
          tacticalExerciseEvaluationUseCase === undefined
        ) {
          throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
            { reason: "this worker has no engineRevision configured for seeded evaluations" },
          ]);
        }
        if (task.mode === "TACTICAL_EXERCISE_EVALUATION") {
          return {
            ok: true,
            mode: "TACTICAL_EXERCISE_EVALUATION",
            result: tacticalExerciseEvaluationUseCase.execute(
              toEvaluateTacticalExercisesCommand(task.request),
              context,
            ),
          };
        }
        if (task.mode === "BATTLE_EVALUATION") {
          return {
            ok: true,
            mode: "BATTLE_EVALUATION",
            result: battleEvaluationUseCase.execute(
              toEvaluateBattlesCommand(task.request),
              context,
            ),
          };
        }
        return {
          ok: true,
          mode: "TOTAL_WAR_EVALUATION",
          result: totalWarEvaluationUseCase.execute(
            toEvaluateTotalWarsCommand(task.request),
            context,
          ),
        };
      }
      if (task.mode === "TOTAL_WAR") {
        return {
          ok: true,
          mode: "TOTAL_WAR",
          result: totalWarUseCase.execute(toSimulateTotalWarCommand(task.request), context),
        };
      }
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
