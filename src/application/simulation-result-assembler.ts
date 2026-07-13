import { ApplicationError } from "./application-error.js";
import { buildBattleObservation, type BattleObservation } from "./battle-observation.js";
import type { BattleStateSnapshot } from "../domain/battle/events/battle-state-snapshot.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import { reduceStateDeltas } from "../domain/battle/events/state-delta-reducer.js";
import type { BattleOutcome, CompletionReason } from "../domain/battle/victory-policy.js";
import type { BattleId, BattleUnitId } from "../domain/shared/ids.js";

export interface SimulateBattleResult {
  readonly battleId: BattleId;
  readonly catalogRevision: string;
  readonly outcome: BattleOutcome;
  readonly completionReason: CompletionReason;
  readonly completedTurn: number;
  readonly observation: BattleObservation;
}

export interface AssembleSimulationResultInput {
  readonly battleId: BattleId;
  readonly catalogRevision: string;
  readonly result: {
    readonly outcome: BattleOutcome;
    readonly completionReason: CompletionReason;
    readonly completedTurn: number;
  };
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleDomainEvent[];
}

function unitSnapshotsEqual(
  a: BattleStateSnapshot["units"][BattleUnitId],
  b: BattleStateSnapshot["units"][BattleUnitId],
): boolean {
  return a.hp === b.hp && a.ap === b.ap && a.pp === b.pp && a.extraGauge === b.extraGauge;
}

/** `status`/`currentTurn`/`units`をキー順に依存せず比較する（独立Reducerによる復元結果の検証用）。 */
function statesEqual(a: BattleStateSnapshot, b: BattleStateSnapshot): boolean {
  if (a.status !== b.status || a.currentTurn !== b.currentTurn) {
    return false;
  }
  const aUnitIds = Object.keys(a.units) as BattleUnitId[];
  const bUnitIds = Object.keys(b.units) as BattleUnitId[];
  if (aUnitIds.length !== bUnitIds.length) {
    return false;
  }
  return aUnitIds.every((unitId) => {
    const bUnit = b.units[unitId];
    return bUnit !== undefined && unitSnapshotsEqual(a.units[unitId]!, bUnit);
  });
}

/**
 * `13_実装計画.md`「M3 最小戦闘縦切り」の`SimulationResultAssembler`。Battleの
 * 勝敗フィールドと、記録済みイベント列・初期/最終状態から組み立てた
 * `BattleObservation`を1つの結果へ統合する。返却前に、独立Reducerで
 * `initialState + transitions`を復元し、与えられた`finalState`と一致することを
 * 検証する（「全状態差分を独立Reducerで復元できる」）。不一致は、どこかの
 * ドメインイベントがStateDeltaを発行し漏らしたことを示す実装不変条件違反であり、
 * 復元不能な結果を黙って返さずエラーにする。
 */
export function assembleSimulationResult(
  input: AssembleSimulationResultInput,
): SimulateBattleResult {
  const observation = buildBattleObservation({
    initialState: input.initialState,
    finalState: input.finalState,
    events: input.events,
  });

  const restoredState = reduceStateDeltas(
    observation.initialState,
    observation.transitions.map((transition) => transition.delta),
  );
  if (!statesEqual(restoredState, observation.finalState)) {
    throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
      {
        reason:
          "initialState + transitions (restored via the independent StateDelta Reducer) does not match finalState; a state-changing event is missing its stateDelta",
      },
    ]);
  }

  return {
    battleId: input.battleId,
    catalogRevision: input.catalogRevision,
    outcome: input.result.outcome,
    completionReason: input.result.completionReason,
    completedTurn: input.result.completedTurn,
    observation,
  };
}
