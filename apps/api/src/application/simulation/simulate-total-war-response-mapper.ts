import {
  SCHEMA_VERSION,
  toBattleLogEventResponseBody,
  toBattleStateResponseBody,
  toFormationPositionResponseBody,
  toStateTransitionResponseBody,
  toUnitBattleSummaryResponseBody,
} from "./simulate-battle-response-mapper.js";
import type {
  SimulateTotalWarResult,
  TotalWarUnitRosterEntry,
} from "./simulation-result-assembler.js";
import type {
  TotalWarResponseBody,
  TotalWarUnitRosterResponseBody,
} from "../contracts/response.js";

/** `10_API設計.md`「TotalWarUnitRosterResponse」。 */
function toTotalWarUnitRosterResponseBody(
  entry: TotalWarUnitRosterEntry,
): TotalWarUnitRosterResponseBody {
  return {
    battleUnitId: entry.battleUnitId,
    unitDefinitionId: entry.unitDefinitionId,
    side: entry.side,
    formationNumber: entry.formationNumber,
    formationPosition: toFormationPositionResponseBody(entry.position),
    coordinate: { x: entry.globalCoordinate.x, y: entry.globalCoordinate.y },
    reappearance: entry.reappearance,
    deployed: entry.deployed,
  };
}

/**
 * `09_アプリケーション設計.md`のApplication Result（`SimulateTotalWarResult`）を
 * `10_API設計.md`「TotalWarResponse」へ変換する。
 *
 * 状態・イベント・状態差分の変換は通常戦闘・戦術演習と同じ関数を使う。総力戦だけに現れる
 * 差分（`addedUnits`／`formations`）と状態の`formations`も共有側が有無だけで写すため、
 * ここで渡すのは、出撃したユニットの静的項目を解決するためのrosterだけである。
 */
export function toTotalWarResponseBody(result: SimulateTotalWarResult): TotalWarResponseBody {
  const stateTransitions = result.stateTransitions.map((transition) =>
    toStateTransitionResponseBody(transition, result.unitRoster),
  );
  const finalStateVersion =
    stateTransitions.length > 0
      ? stateTransitions[stateTransitions.length - 1]!.stateVersionAfter
      : 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    battleId: result.battleId,
    catalogRevision: result.catalogRevision,
    result: {
      outcome: result.outcome,
      completionReason: result.completionReason,
      completedTurn: result.completedTurn,
      stages: result.stages.map((stage) => ({
        stageNumber: stage.stageNumber,
        allyFormationNumber: stage.allyFormationNumber,
        enemyFormationNumber: stage.enemyFormationNumber,
        startTurn: stage.startTurn,
        endTurn: stage.endTurn,
        defeatedSides: [...stage.defeatedSides],
      })),
      defeatedFormationCounts: {
        ally: result.defeatedFormationCounts.ally,
        enemy: result.defeatedFormationCounts.enemy,
      },
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
    unitRoster: result.unitRoster.map(toTotalWarUnitRosterResponseBody),
    unitSummaries: result.unitSummaries.map(toUnitBattleSummaryResponseBody),
    events: result.events.map(toBattleLogEventResponseBody),
    stateTransitions,
  };
}
