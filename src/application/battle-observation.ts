import type { BattleStateSnapshot } from "../domain/battle/events/battle-state-snapshot.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import type { StateDelta } from "../domain/battle/events/state-delta.js";

export interface StateTransition {
  readonly sequence: number;
  readonly stateVersionBefore: number;
  readonly stateVersionAfter: number;
  readonly delta: StateDelta;
}

/**
 * `08_ドメインイベント.md`「Battle Observation」。内部イベント列を、連番・因果関係・
 * 状態差分を保ったまま公開する。`stateAt(sequence N) = initialState + delta(1) + ... + delta(N)`
 * の`delta(*)`列（`transitions`）を、独立した`StateDelta Reducer`
 * （`../domain/battle/events/state-delta-reducer.js`）で`initialState`へ折りたたむと
 * `finalState`と一致する。
 */
export interface BattleObservation {
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleDomainEvent[];
  readonly transitions: readonly StateTransition[];
}

export interface BuildBattleObservationInput {
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleDomainEvent[];
}

export function buildBattleObservation(input: BuildBattleObservationInput): BattleObservation {
  const transitions: StateTransition[] = [];
  for (const event of input.events) {
    if (event.stateDelta === undefined) {
      continue;
    }
    transitions.push({
      sequence: event.sequence,
      stateVersionBefore: event.stateVersionBefore,
      stateVersionAfter: event.stateVersionAfter,
      delta: event.stateDelta,
    });
  }
  return {
    initialState: input.initialState,
    finalState: input.finalState,
    events: input.events,
    transitions,
  };
}
