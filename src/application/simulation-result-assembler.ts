import { ApplicationError } from "./application-error.js";
import {
  buildBattleObservation,
  type BattleObservation,
  type StateTransition,
} from "./battle-observation.js";
import type { BattleStateSnapshot } from "../domain/battle/events/battle-state-snapshot.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import { reduceStateDeltas } from "../domain/battle/events/state-delta-reducer.js";
import type { BattleOutcome, CompletionReason } from "../domain/battle/victory-policy.js";
import { DomainValidationError } from "../domain/shared/errors.js";
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
 * `08_ドメインイベント.md`「状態バージョン」契約: 先頭のstateVersionBeforeは0、
 * 各要素はstateVersionAfter === stateVersionBefore + 1、前要素のAfterと次要素の
 * Beforeが一致する。欠番・逆順・重複したバージョンを検出する
 * （Reducerはdeltaの内容だけを見るため、この検証で別途担保する必要がある）。
 */
function assertStateVersionContinuity(transitions: readonly StateTransition[]): void {
  let expectedBefore = 0;
  for (const [index, transition] of transitions.entries()) {
    if (transition.stateVersionBefore !== expectedBefore) {
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        {
          reason: `transitions[${index}].stateVersionBefore (${transition.stateVersionBefore}) does not continue from the previous stateVersionAfter (expected ${expectedBefore}); a stateVersion is missing, duplicated, or out of order`,
        },
      ]);
    }
    if (transition.stateVersionAfter !== transition.stateVersionBefore + 1) {
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        {
          reason: `transitions[${index}].stateVersionAfter (${transition.stateVersionAfter}) is not stateVersionBefore + 1 (${transition.stateVersionBefore})`,
        },
      ]);
    }
    expectedBefore = transition.stateVersionAfter;
  }
}

/**
 * `13_実装計画.md`「M3 最小戦闘縦切り」の`SimulationResultAssembler`。Battleの
 * 勝敗フィールドと、記録済みイベント列・初期/最終状態から組み立てた
 * `BattleObservation`を1つの結果へ統合する。返却前に、`stateVersion`の連続性を
 * 検証したうえで、独立Reducerで`initialState + transitions`を復元し、与えられた
 * `finalState`と一致することを検証する（「全状態差分を独立Reducerで復元できる」）。
 * これらの不整合は、事前検証(preflight)通過後に発生した内部イベント・差分の
 * バグを示す実装不変条件違反であり、`09_アプリケーション設計.md`のエラー分類に
 * 従い`INTERNAL_INVARIANT_VIOLATION`として扱う。`DomainValidationError`を
 * そのまま外側のcatchへ伝播させると`INVALID_COMMAND`（クライアント入力違反）へ
 * 誤変換されるため、ここで捕捉して変換する。
 */
export function assembleSimulationResult(
  input: AssembleSimulationResultInput,
): SimulateBattleResult {
  const observation = buildBattleObservation({
    initialState: input.initialState,
    finalState: input.finalState,
    events: input.events,
  });

  assertStateVersionContinuity(observation.transitions);

  let restoredState: BattleStateSnapshot;
  try {
    restoredState = reduceStateDeltas(
      observation.initialState,
      observation.transitions.map((transition) => transition.delta),
    );
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        {
          reason: `the independent StateDelta Reducer rejected the recorded transitions: ${error.message}`,
        },
      ]);
    }
    throw error;
  }
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
