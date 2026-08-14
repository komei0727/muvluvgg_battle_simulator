import {
  SCHEMA_VERSION,
  toBattleLogEventResponseBody,
  toBattleStateResponseBody,
  toStateTransitionResponseBody,
  toUnitBattleSummaryResponseBody,
} from "./simulate-battle-response-mapper.js";
import type { SimulateTacticalExerciseResult } from "./simulation-result-assembler.js";
import type { TacticalExerciseResponseBody } from "../contracts/response.js";

/**
 * `09_アプリケーション設計.md`のApplication Result（`SimulateTacticalExerciseResult`）を
 * `10_API設計.md`「TacticalExerciseResponse」へ変換する。
 *
 * 状態・イベント・状態差分の変換は`toBattleSimulationResponseBody`とまったく同じ関数を
 * 使う——「`BattleSimulationResponse`と同じ構造を再利用し、`result`だけを演習結果へ
 * 差し替える」契約を、2つの変換を並べて保つのではなく共有で満たすためである。
 * 演習だけに現れる差分（`exercise`／`units.<id>.baseCombatStats`）も共有側が差分の
 * 有無だけで写すため、ここでモードを見る必要はない。
 */
export function toTacticalExerciseResponseBody(
  result: SimulateTacticalExerciseResult,
): TacticalExerciseResponseBody {
  const stateTransitions = result.stateTransitions.map(toStateTransitionResponseBody);
  const finalStateVersion =
    stateTransitions.length > 0
      ? stateTransitions[stateTransitions.length - 1]!.stateVersionAfter
      : 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    battleId: result.battleId,
    catalogRevision: result.catalogRevision,
    // R-TEX-10 #1: 演習は勝敗を確定しないため`outcome`を持たない。
    result: {
      completionReason: result.completionReason,
      completedTurn: result.completedTurn,
      totalScore: result.totalScore,
      breakCount: result.breakCount,
      breaks: result.breaks.map((entry) => ({
        breakNumber: entry.breakNumber,
        turnNumber: entry.turnNumber,
        cumulativeScoreAtBreak: entry.cumulativeScoreAtBreak,
      })),
    },
    initialState: toBattleStateResponseBody(0, result.initialState, result.unitRoster),
    ...(result.finalState !== undefined
      ? {
          finalState: toBattleStateResponseBody(
            finalStateVersion,
            result.finalState,
            result.unitRoster,
          ),
        }
      : {}),
    unitSummaries: result.unitSummaries.map(toUnitBattleSummaryResponseBody),
    events: result.events.map(toBattleLogEventResponseBody),
    stateTransitions,
  };
}
