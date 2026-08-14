import { SimulateBattleUseCase } from "../../application/simulation/simulate-battle-use-case.js";
import { SimulateTacticalExerciseUseCase } from "../../application/simulation/simulate-tactical-exercise-use-case.js";
import type { SimulateBattleCommand } from "../../application/simulation/simulate-battle-command.js";
import type { SimulateTacticalExerciseCommand } from "../../application/simulation/simulate-tactical-exercise-command.js";
import type { SimulationExecutionContext } from "../../application/simulation/simulation-execution-context.js";
import type {
  SimulateBattleResult,
  SimulateTacticalExerciseResult,
} from "../../application/simulation/simulation-result-assembler.js";
import type { BattleStateSnapshot } from "../../domain/battle/lifecycle/battle-state-snapshot.js";
import type { BattleCatalog } from "../../domain/ports/battle-catalog.js";
import { ManualClock } from "../clock/manual-clock.js";
import { FixedBattleIdGenerator } from "../id/fixed-battle-id-generator.js";
import { SequenceRandomSourceFactory } from "../random/sequence-random-source-factory.js";

/**
 * `SUMMARY`は`finalState`を返さない（`10_API設計.md`「公開レベル」）。シナリオ層は
 * 最終状態・イベント列・状態差分をassert対象にするため必ず`DETAILED`で走らせる
 * （`definition-builders.ts`の既定）。取り違えを`undefined`のまま素通りさせず、
 * ここで明示的に失敗させたうえで非optionalへ絞る。
 */
export function requireFullObservation<
  T extends { readonly finalState: BattleStateSnapshot | undefined },
>(result: T): T & { readonly finalState: BattleStateSnapshot } {
  if (result.finalState === undefined) {
    throw new Error(
      "scenario harness requires logLevel DETAILED: a SUMMARY run omits finalState/events/stateTransitions",
    );
  }
  return result as T & { readonly finalState: BattleStateSnapshot };
}

/** `finalState`が確実に届く（＝`DETAILED`で走らせた）シナリオ結果。 */
export type FullObservationBattleResult = SimulateBattleResult & {
  readonly finalState: BattleStateSnapshot;
};

export type FullObservationExerciseResult = SimulateTacticalExerciseResult & {
  readonly finalState: BattleStateSnapshot;
};

export interface RunScenarioOptions {
  /** 合成または実Catalog。`CatalogBuilder.build()` の戻り値をそのまま渡せる。 */
  readonly catalog: BattleCatalog;
  readonly command: SimulateBattleCommand;
  /** RandomSourceが順に返す値。省略時は空（乱数を消費しないシナリオ用）。 */
  readonly randomValues?: readonly number[];
  /** 生成するBattle IDの列。省略時は `B_TEST` を使う。 */
  readonly battleIds?: readonly string[];
  readonly clockStartMs?: number;
  readonly context?: Partial<SimulationExecutionContext>;
}

/**
 * Battle Scenario Harness（`12_テスト戦略.md`「シナリオHarness」）。実際のFormation・
 * Battle・Observationを通し、HTTPとWorkerだけを通さずに戦闘を完走させる。乱数・時刻・IDは
 * 決定的なテスト実装へ固定する。戻り値の `SimulateBattleResult` に対し、勝敗・最終状態・
 * イベント順・状態差分・乱数消費を個別にassertできる。
 */
export function runScenario(options: RunScenarioOptions): FullObservationBattleResult {
  return requireFullObservation(runScenarioRaw(options));
}

/**
 * `SUMMARY`のように`finalState`・`events`・`stateTransitions`が返らないレベルを
 * **意図的に**検証するシナリオ用。通常は{@link runScenario}を使う。
 */
export function runScenarioRaw(options: RunScenarioOptions): SimulateBattleResult {
  const useCase = new SimulateBattleUseCase({
    battleCatalog: options.catalog,
    battleIdGenerator: new FixedBattleIdGenerator([...(options.battleIds ?? ["B_TEST"])]),
    randomSourceFactory: new SequenceRandomSourceFactory([...(options.randomValues ?? [])]),
    clock: new ManualClock(options.clockStartMs ?? 0),
  });
  return useCase.execute(options.command, {
    requestId: "scenario-test",
    deadlineEpochMs: Number.MAX_SAFE_INTEGER,
    ...options.context,
  });
}

export interface RunExerciseScenarioOptions extends Omit<RunScenarioOptions, "command"> {
  readonly command: SimulateTacticalExerciseCommand;
}

/**
 * 戦術演習（UC-03）版のHarness。`runScenario`と同じ決定的な乱数・時刻・IDのまま
 * `SimulateTacticalExerciseUseCase`を通し、スコア・ブレイク履歴を含む演習結果に
 * 対してassertできるようにする。
 */
export function runExerciseScenario(
  options: RunExerciseScenarioOptions,
): FullObservationExerciseResult {
  return requireFullObservation(runExerciseScenarioRaw(options));
}

/** {@link runScenarioRaw}の戦術演習版。 */
export function runExerciseScenarioRaw(
  options: RunExerciseScenarioOptions,
): SimulateTacticalExerciseResult {
  const useCase = new SimulateTacticalExerciseUseCase({
    battleCatalog: options.catalog,
    battleIdGenerator: new FixedBattleIdGenerator([...(options.battleIds ?? ["B_TEST"])]),
    randomSourceFactory: new SequenceRandomSourceFactory([...(options.randomValues ?? [])]),
    clock: new ManualClock(options.clockStartMs ?? 0),
  });
  return useCase.execute(options.command, {
    requestId: "scenario-test",
    deadlineEpochMs: Number.MAX_SAFE_INTEGER,
    ...options.context,
  });
}

/**
 * 不変条件の検査対象。通常戦闘・戦術演習のどちらの結果でも、勝敗以外の共通部分
 * （イベント列・状態差分・最終状態）だけを見る。
 */
type BattleInvariantSubject = Pick<SimulateBattleResult, "events" | "stateTransitions"> & {
  readonly finalState: BattleStateSnapshot;
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Battle invariant violated: ${message}`);
  }
}

/** 公開イベントの `sequence` が重複せず狭義単調増加すること。 */
export function assertEventSequenceMonotonic(result: BattleInvariantSubject): void {
  const sequences = result.events.map((event) => event.sequence);
  for (let i = 1; i < sequences.length; i++) {
    assert(
      sequences[i]! > sequences[i - 1]!,
      `event sequence must strictly increase: ${sequences[i - 1]} -> ${sequences[i]}`,
    );
  }
}

/** `StateTransition` の `stateVersion` が連続すること（before(n) と after(n) が繋がる）。 */
export function assertStateVersionsContiguous(result: BattleInvariantSubject): void {
  let previousAfter: number | undefined;
  for (const transition of result.stateTransitions) {
    assert(
      transition.stateVersionAfter === transition.stateVersionBefore + 1,
      `stateVersion must advance by 1: ${transition.stateVersionBefore} -> ${transition.stateVersionAfter}`,
    );
    if (previousAfter !== undefined) {
      assert(
        transition.stateVersionBefore === previousAfter,
        `stateVersion must be contiguous: expected ${previousAfter}, got ${transition.stateVersionBefore}`,
      );
    }
    previousAfter = transition.stateVersionAfter;
  }
}

/** 最終状態の各ユニットの HP/AP/PP/EX が非負で、HPが最大HPを超えないこと。 */
export function assertResourcesWithinBounds(result: BattleInvariantSubject): void {
  for (const [unitId, unit] of Object.entries(result.finalState.units)) {
    assert(unit.hp >= 0, `${unitId} hp must be non-negative (got ${unit.hp})`);
    assert(
      unit.hp <= unit.combatStats.maximumHp,
      `${unitId} hp ${unit.hp} must not exceed maximumHp ${unit.combatStats.maximumHp}`,
    );
    assert(unit.ap >= 0, `${unitId} ap must be non-negative (got ${unit.ap})`);
    assert(unit.pp >= 0, `${unitId} pp must be non-negative (got ${unit.pp})`);
    assert(
      unit.extraGauge >= 0,
      `${unitId} extraGauge must be non-negative (got ${unit.extraGauge})`,
    );
  }
}

/** 上記の基本不変条件をまとめて検証する。 */
export function assertBattleInvariants(result: BattleInvariantSubject): void {
  assertEventSequenceMonotonic(result);
  assertStateVersionsContiguous(result);
  assertResourcesWithinBounds(result);
}
