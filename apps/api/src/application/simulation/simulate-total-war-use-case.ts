import { ApplicationError } from "../contracts/application-error.js";
import type { BattleExecutionDependencies } from "./battle-execution.js";
import {
  validateTotalWarCommandShape,
  type SimulateTotalWarCommand,
} from "./simulate-total-war-command.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import {
  assembleTotalWarResult,
  type SimulateTotalWarResult,
} from "./simulation-result-assembler.js";
import { executeTotalWarToCompletion } from "./total-war-execution.js";
import { isTotalWarBattleResult } from "../../domain/battle/events/state-delta.js";

export type SimulateTotalWarUseCaseDependencies = BattleExecutionDependencies;

/**
 * `09_アプリケーション設計.md`「SimulateTotalWarUseCase」（UC-05、R-TWR-01～06）。
 * 他のモードと同じ構成要素（Catalogスナップショット取得、preflight検証、`FormationFactory`、
 * `Battle`、Observation、Assembler）を使い、各陣営に複数の編成を持たせて戦闘モード
 * `TOTAL_WAR`の`Battle`を生成する。
 */
export class SimulateTotalWarUseCase {
  private readonly dependencies: SimulateTotalWarUseCaseDependencies;

  constructor(dependencies: SimulateTotalWarUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  execute(
    command: SimulateTotalWarCommand,
    context: SimulationExecutionContext,
  ): SimulateTotalWarResult {
    const shapeViolations = validateTotalWarCommandShape(command);
    if (shapeViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const executed = executeTotalWarToCompletion(command, context, this.dependencies);

    if (!isTotalWarBattleResult(executed.result)) {
      // `TOTAL_WAR`のBattleしか生成しないため到達しない。総力戦の結果は引き分けと戦闘履歴を
      // 持つ（R-TWR-06 #4）ため、他のモードの結果をそのまま返すことはできない。
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        { reason: "a total war resolved a result of another battle mode" },
      ]);
    }

    return assembleTotalWarResult({
      battleId: executed.battleId,
      catalogRevision: executed.catalogRevision,
      logLevel: command.logLevel,
      result: executed.result,
      initialState: executed.initialState,
      finalState: executed.finalState,
      events: executed.events,
      unitRoster: executed.unitRoster,
      reappearanceBattleUnitIds: executed.reappearanceBattleUnitIds,
    });
  }
}
