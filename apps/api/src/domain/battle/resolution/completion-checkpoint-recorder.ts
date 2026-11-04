import {
  evaluateCompletionCheckpoint,
  type CompletionCheckpointMode,
  type CompletionCheckpointOutcome,
} from "../outcome/completion-checkpoint.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { EventRecorder } from "../events/event-recorder.js";
import type { DomainEventId, ResolutionScopeId } from "../../shared/event-ids.js";

/**
 * `FormationDefeated`を、判定タイミングを開いたトップレベルイベント（`parentEventId`）の子として
 * 発行するための文脈（`08_ドメインイベント.md`「総力戦イベント」）。
 */
export interface CompletionCheckpointEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
  readonly parentEventId: DomainEventId;
}

/**
 * R-END-01の判定タイミング1回分。判定（`evaluateCompletionCheckpoint`）を行い、総力戦で
 * 新たに検出した編成の全滅を味方、敵の順に`FormationDefeated`として発行する（R-TWR-03 #7）。
 * 結果判定（`BattleCompleted`）は呼び出し側がこの後で行うため、全滅は常にそれより前に並ぶ。
 */
export function passCompletionCheckpoint(
  mode: CompletionCheckpointMode,
  units: readonly BattleUnit[],
  turnLimitReached: boolean,
  context: CompletionCheckpointEventContext,
): CompletionCheckpointOutcome {
  const outcome = evaluateCompletionCheckpoint(mode, units, turnLimitReached, context.turnNumber);
  for (const defeat of outcome.formationDefeats) {
    context.recorder.record({
      eventType: "FormationDefeated",
      category: "FACT",
      turnNumber: context.turnNumber,
      cycleNumber: context.cycleNumber,
      resolutionScopeId: context.resolutionScopeId,
      parentEventId: context.parentEventId,
      rootEventId: context.rootEventId,
      payload: {
        side: defeat.side,
        formationNumber: defeat.formationNumber,
        turnNumber: context.turnNumber,
        remainingReserveCount: defeat.remainingReserveCount,
      },
    });
  }
  return outcome;
}
