import { ApplicationError } from "../contracts/application-error.js";
import { executeBattleToCompletion, type BattleExecutionDependencies } from "./battle-execution.js";
import {
  EXERCISE_TURN_LIMIT,
  validateTacticalExerciseCommandShape,
  type SimulateTacticalExerciseCommand,
} from "./simulate-tactical-exercise-command.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import {
  assembleTacticalExerciseResult,
  type SimulateTacticalExerciseResult,
} from "./simulation-result-assembler.js";
import { isExerciseBattleResult } from "../../domain/battle/events/state-delta.js";

export type SimulateTacticalExerciseUseCaseDependencies = BattleExecutionDependencies;

/**
 * `09_アプリケーション設計.md`「SimulateTacticalExerciseUseCase」（UC-03、R-TEX-01～10）。
 * `SimulateBattleUseCase`と同じ構成要素（Catalogスナップショット取得、preflight検証、
 * `FormationFactory`、`Battle`、Observation、Assembler）を`executeBattleToCompletion`
 * として共有し、戦闘モード`TACTICAL_EXERCISE`と規定ターン数`EXERCISE_TURN_LIMIT`で
 * `Battle`を生成する点だけが異なる。
 */
export class SimulateTacticalExerciseUseCase {
  private readonly dependencies: SimulateTacticalExerciseUseCaseDependencies;

  constructor(dependencies: SimulateTacticalExerciseUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  execute(
    command: SimulateTacticalExerciseCommand,
    context: SimulationExecutionContext,
  ): SimulateTacticalExerciseResult {
    const shapeViolations = validateTacticalExerciseCommandShape(command);
    if (shapeViolations.length > 0) {
      // R-TEX-01 #3: 敵編成の違反は戦闘開始前のリクエスト不備（422）として拒否する。
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const executed = executeBattleToCompletion(command, context, this.dependencies, {
      mode: "TACTICAL_EXERCISE",
      // R-TEX-01 #4: 規定ターン数は5固定であり、リクエストからは受け取らない。
      turnLimit: EXERCISE_TURN_LIMIT,
    });

    if (!isExerciseBattleResult(executed.result)) {
      // `TACTICAL_EXERCISE`のBattleしか生成しないため到達しない。演習は勝敗を
      // 持たない（R-TEX-10 #1）ため、通常戦闘の結果をそのまま返すことはできない。
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        { reason: "a tactical exercise resolved a normal battle result" },
      ]);
    }

    return assembleTacticalExerciseResult({
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
