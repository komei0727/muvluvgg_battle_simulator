import { buildBattleObservation, type BattleObservation } from "./battle-observation.js";
import type { BattleStateSnapshot } from "../domain/battle/events/battle-state-snapshot.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import type { BattleOutcome, CompletionReason } from "../domain/battle/victory-policy.js";
import type { BattleId } from "../domain/shared/ids.js";

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

/**
 * `13_実装計画.md`「M3 最小戦闘縦切り」の`SimulationResultAssembler`。Battleの
 * 勝敗フィールドと、記録済みイベント列・初期/最終状態から組み立てた
 * `BattleObservation`を1つの結果へ統合する。
 */
export function assembleSimulationResult(
  input: AssembleSimulationResultInput,
): SimulateBattleResult {
  const observation = buildBattleObservation({
    initialState: input.initialState,
    finalState: input.finalState,
    events: input.events,
  });
  return {
    battleId: input.battleId,
    catalogRevision: input.catalogRevision,
    outcome: input.result.outcome,
    completionReason: input.result.completionReason,
    completedTurn: input.result.completedTurn,
    observation,
  };
}
