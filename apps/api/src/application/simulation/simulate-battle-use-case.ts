import { ApplicationError } from "../contracts/application-error.js";
import { executeBattleToCompletion, type BattleExecutionDependencies } from "./battle-execution.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import {
  assembleSimulationResult,
  type SimulateBattleResult,
} from "./simulation-result-assembler.js";
import { validateCommandShape, type SimulateBattleCommand } from "./simulate-battle-command.js";
import { isExerciseBattleResult } from "../../domain/battle/events/state-delta.js";

export type SimulateBattleUseCaseDependencies = BattleExecutionDependencies;

/**
 * `09_アプリケーション設計.md` の SimulateBattleUseCase。`13_実装計画.md`
 * 「M3 最小戦闘縦切り」のうち、ActionQueue・AS選択・命中・会心・ダメージ・
 * 勝敗までを扱う。Catalog取得からBattle完了までの実行本体は、戦術演習
 * （`SimulateTacticalExerciseUseCase`）と共有する`executeBattleToCompletion`が持つ。
 */
export class SimulateBattleUseCase {
  private readonly dependencies: SimulateBattleUseCaseDependencies;

  constructor(dependencies: SimulateBattleUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  execute(
    command: SimulateBattleCommand,
    context: SimulationExecutionContext,
  ): SimulateBattleResult {
    const shapeViolations = validateCommandShape(command);
    if (shapeViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const executed = executeBattleToCompletion(command, context, this.dependencies, {
      mode: "NORMAL",
      turnLimit: command.turnLimit,
    });

    if (isExerciseBattleResult(executed.result)) {
      // このユースケースは`NORMAL`のBattleしか生成しないため到達しない。演習結果
      // （勝敗を持たない、R-TEX-10 #1）は`SimulateTacticalExerciseUseCase`が扱う。
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        { reason: "a normal battle simulation resolved a tactical exercise result" },
      ]);
    }

    return assembleSimulationResult({
      battleId: executed.battleId,
      catalogRevision: executed.catalogRevision,
      logLevel: command.logLevel,
      result: executed.result,
      initialState: executed.initialState,
      finalState: executed.finalState,
      events: executed.events,
      unitRoster: executed.unitRoster,
    });
  }
}
