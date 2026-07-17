import { ApplicationError } from "./application-error.js";
import { toBattleLogEvents, type BattleLogEvent } from "./battle-log-event.js";
import { projectEventsForLogLevel } from "./battle-log-projection.js";
import { buildBattleObservation, type StateTransition } from "./battle-observation.js";
import type { LogLevel } from "./simulate-battle-command.js";
import type {
  BattleResultSnapshot,
  BattleStateSnapshot,
  BattleUnitRosterEntry,
} from "../domain/battle/events/battle-state-snapshot.js";
import type { BattleDomainEvent } from "../domain/battle/events/domain-event.js";
import { reduceStateDeltas, sameChargeState } from "../domain/battle/events/state-delta-reducer.js";
import type { CooldownState } from "../domain/battle/events/state-delta.js";
import type { BattleOutcome, CompletionReason } from "../domain/battle/victory-policy.js";
import type { SkillDefinitionId } from "../domain/catalog/catalog-ids.js";
import { DomainValidationError } from "../domain/shared/errors.js";
import type { BattleId, BattleUnitId } from "../domain/shared/ids.js";

/** `09_アプリケーション設計.md`「SimulateBattleResult」と同じトップレベル形。 */
export interface SimulateBattleResult {
  readonly battleId: BattleId;
  readonly catalogRevision: string;
  readonly outcome: BattleOutcome;
  readonly completionReason: CompletionReason;
  readonly completedTurn: number;
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleLogEvent[];
  readonly stateTransitions: readonly StateTransition[];
  /** `10_API設計.md`「BattleUnitStateResponse」の静的項目。Response Mapperが可変状態と合成する。 */
  readonly unitRoster: readonly BattleUnitRosterEntry[];
}

export interface AssembleSimulationResultInput {
  readonly battleId: BattleId;
  readonly catalogRevision: string;
  readonly logLevel: LogLevel;
  readonly result: {
    readonly outcome: BattleOutcome;
    readonly completionReason: CompletionReason;
    readonly completedTurn: number;
  };
  readonly initialState: BattleStateSnapshot;
  readonly finalState: BattleStateSnapshot;
  readonly events: readonly BattleDomainEvent[];
  readonly unitRoster: readonly BattleUnitRosterEntry[];
}

/**
 * `unit`/`remaining`（独立Reducerが`StateDelta`から復元できる項目）だけを比較する。
 * `setActionId`/`setTurnNumber`はBattle集約から直接captureする現在値限定の注釈で
 * あり`UnitStateDelta.cooldowns`には運ばれないため（`state-delta.ts`の`CooldownState`
 * コメント参照）、比較対象に含めるとReducer復元状態との不一致を誤検出する。
 */
function cooldownStatesEqual(
  a: Readonly<Record<SkillDefinitionId, CooldownState>> | undefined,
  b: Readonly<Record<SkillDefinitionId, CooldownState>> | undefined,
): boolean {
  const aEntries = Object.entries(a ?? {}) as [SkillDefinitionId, CooldownState][];
  const bCooldowns = b ?? {};
  if (aEntries.length !== Object.keys(bCooldowns).length) {
    return false;
  }
  return aEntries.every(([skillDefinitionId, state]) => {
    const other = bCooldowns[skillDefinitionId];
    return other !== undefined && state.unit === other.unit && state.remaining === other.remaining;
  });
}

function unitSnapshotsEqual(
  a: BattleStateSnapshot["units"][BattleUnitId],
  b: BattleStateSnapshot["units"][BattleUnitId],
): boolean {
  return (
    a.hp === b.hp &&
    a.ap === b.ap &&
    a.pp === b.pp &&
    a.extraGauge === b.extraGauge &&
    cooldownStatesEqual(a.cooldowns, b.cooldowns) &&
    sameChargeState(a.charge, b.charge)
  );
}

function resultsEqual(
  a: BattleResultSnapshot | undefined,
  b: BattleResultSnapshot | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.outcome === b.outcome &&
    a.completionReason === b.completionReason &&
    a.completedTurn === b.completedTurn
  );
}

/** `status`/`currentTurn`/`units`/`result`をキー順に依存せず比較する（独立Reducerによる復元結果の検証用）。 */
function statesEqual(a: BattleStateSnapshot, b: BattleStateSnapshot): boolean {
  if (
    a.status !== b.status ||
    a.currentTurn !== b.currentTurn ||
    !resultsEqual(a.result, b.result)
  ) {
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
 * 事前検証(preflight)通過後に発生した内部イベント・差分のバグ（`DomainValidationError`）
 * を`INTERNAL_INVARIANT_VIOLATION`へ変換して再送出する。`DomainValidationError`を
 * そのまま外側のcatchへ伝播させると`INVALID_COMMAND`（クライアント入力違反）へ
 * 誤変換されるため、ここで捕捉して変換する。
 */
function runOrConvertToInternalInvariant<T>(
  operation: () => T,
  describe: (message: string) => string,
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        { reason: describe(error.message) },
      ]);
    }
    throw error;
  }
}

/**
 * `08_ドメインイベント.md`「状態バージョン」契約: 先頭のstateVersionBeforeは0、
 * 各要素はstateVersionAfter === stateVersionBefore + 1、前要素のAfterと次要素の
 * Beforeが一致する。欠番・逆順・重複したバージョンを検出する
 * （Reducerはdeltaの内容だけを見るため、この検証で別途担保する必要がある）。
 */
function assertStateVersionContinuity(stateTransitions: readonly StateTransition[]): void {
  let expectedBefore = 0;
  for (const [index, transition] of stateTransitions.entries()) {
    if (transition.stateVersionBefore !== expectedBefore) {
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        {
          reason: `stateTransitions[${index}].stateVersionBefore (${transition.stateVersionBefore}) does not continue from the previous stateVersionAfter (expected ${expectedBefore}); a stateVersion is missing, duplicated, or out of order`,
        },
      ]);
    }
    if (transition.stateVersionAfter !== transition.stateVersionBefore + 1) {
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        {
          reason: `stateTransitions[${index}].stateVersionAfter (${transition.stateVersionAfter}) is not stateVersionBefore + 1 (${transition.stateVersionBefore})`,
        },
      ]);
    }
    expectedBefore = transition.stateVersionAfter;
  }
}

/**
 * `13_実装計画.md`「M3 最小戦闘縦切り」の`SimulationResultAssembler`。Battleの
 * 勝敗フィールドと、記録済みイベント列・初期/最終状態から`SimulateBattleResult`
 * （`09_アプリケーション設計.md`のトップレベル形）を組み立てる。`events`は
 * `logLevel`に応じて`projectEventsForLogLevel`で間引いたうえで、内部
 * `BattleDomainEvent`を公開`BattleLogEvent`（`10_API設計.md`
 * 「BattleLogEventResponse」: `type`は大文字スネークケース、`payload`は
 * `details`、`parentEventId`/`rootEventId`は`parentSequence`/`rootSequence`、
 * `stateDelta`は直接含めず`stateTransitionIndex`（`stateTransitions`配列の
 * 0始まりインデックス）で参照）へ変換する。`stateTransitions`
 * （状態復元に必要な全差分）は公開レベルに関わらず完全なまま返す
 * （「イベント公開レベルによって表示用イベントを間引いても、状態復元に必要な
 * 差分はstateTransitionsから失われない」）。
 *
 * 返却前に、`stateVersion`の連続性を検証したうえで、独立Reducerで
 * `initialState + stateTransitions`を復元し、与えられた`finalState`と一致する
 * ことを検証する（「全状態差分を独立Reducerで復元できる」）。また、`events`への
 * 変換（`parentSequence`/`rootSequence`解決）も、内部イベント間のダングリング
 * 参照（存在しない`parentEventId`/`rootEventId`）を検出する。これらはいずれも
 * 事前検証(preflight)通過後に発生した内部イベント・差分のバグを示す実装不変条件
 * 違反であり、`09_アプリケーション設計.md`のエラー分類に従い
 * `INTERNAL_INVARIANT_VIOLATION`として扱う（`runOrConvertToInternalInvariant`）。
 */
export function assembleSimulationResult(
  input: AssembleSimulationResultInput,
): SimulateBattleResult {
  const observation = buildBattleObservation({
    initialState: input.initialState,
    finalState: input.finalState,
    events: input.events,
  });

  assertStateVersionContinuity(observation.stateTransitions);

  const restoredState = runOrConvertToInternalInvariant(
    () =>
      reduceStateDeltas(
        observation.initialState,
        observation.stateTransitions.map((transition) => transition.stateDelta),
      ),
    (message) => `the independent StateDelta Reducer rejected the recorded transitions: ${message}`,
  );
  if (!statesEqual(restoredState, observation.finalState)) {
    throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
      {
        reason:
          "initialState + stateTransitions (restored via the independent StateDelta Reducer) does not match finalState; a state-changing event is missing its stateDelta",
      },
    ]);
  }

  return {
    battleId: input.battleId,
    catalogRevision: input.catalogRevision,
    outcome: input.result.outcome,
    completionReason: input.result.completionReason,
    completedTurn: input.result.completedTurn,
    initialState: observation.initialState,
    finalState: observation.finalState,
    events: runOrConvertToInternalInvariant(
      () =>
        toBattleLogEvents(
          projectEventsForLogLevel(observation.events, input.logLevel),
          observation.events,
          observation.stateTransitions,
        ),
      (message) => `BattleLogEvent conversion rejected the recorded events: ${message}`,
    ),
    stateTransitions: observation.stateTransitions,
    unitRoster: input.unitRoster,
  };
}
