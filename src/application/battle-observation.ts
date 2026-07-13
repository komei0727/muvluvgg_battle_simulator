import type { BattleStateSnapshot } from "../domain/battle/events/battle-state-snapshot.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import type { StateDelta } from "../domain/battle/events/state-delta.js";

/** `09_アプリケーション設計.md`「SimulateBattleResult」の`StateTransition`と同じ形。 */
export interface StateTransition {
  readonly causedBySequence: number;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  readonly stateDelta: StateDelta;
}

/**
 * `08_ドメインイベント.md`「Battle Observation」。内部イベント列を、連番・因果関係・
 * 状態差分を保ったまま蓄積する。`stateAt(sequence N) = initialState + delta(1) + ... + delta(N)`
 * の`delta(*)`列（`stateTransitions`）を、独立した`StateDelta Reducer`
 * （`../domain/battle/events/state-delta-reducer.js`）で`initialState`へ折りたたむと
 * `finalState`と一致する。`events`は公開レベルによる絞り込み前の内部イベント全件であり、
 * 公開レベルに応じた投影（`battle-log-projection.js`）は`SimulationResultAssembler`の責務。
 */
export interface BattleObservation {
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleDomainEvent[];
  readonly stateTransitions: readonly StateTransition[];
}

export interface BuildBattleObservationInput {
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleDomainEvent[];
}

export function buildBattleObservation(input: BuildBattleObservationInput): BattleObservation {
  const stateTransitions: StateTransition[] = [];
  for (const event of input.events) {
    if (event.stateDelta === undefined) {
      continue;
    }
    stateTransitions.push({
      causedBySequence: event.sequence,
      stateVersionBefore: event.stateVersionBefore,
      stateVersionAfter: event.stateVersionAfter,
      stateDelta: event.stateDelta,
    });
  }
  return {
    initialState: input.initialState,
    finalState: input.finalState,
    events: input.events,
    stateTransitions,
  };
}
