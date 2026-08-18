import { ApplicationError, type Violation } from "../contracts/application-error.js";
import { projectAllyUnitRunMetrics } from "./ally-unit-run-metrics.js";
import type { SimulationExecutionLimits } from "./battle-execution.js";
import {
  validateEvaluateTacticalExerciseCandidatesCommandShape,
  type EvaluateTacticalExerciseCandidatesCommand,
  type EvaluationLimits,
  type TacticalExerciseCandidateInput,
} from "./evaluate-tactical-exercise-candidates-command.js";
import { runPreflight } from "./simulation-preflight-validator.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import { SimulateTacticalExerciseUseCase } from "./simulate-tactical-exercise-use-case.js";
import type { SimulateTacticalExerciseResult } from "./simulation-result-assembler.js";
import type { FormationPairCommand } from "./simulate-battle-command.js";
import type { BattleCatalog, BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";
import type { Clock } from "../../domain/ports/clock.js";
import type { SeededRandomSourceProvider } from "../../domain/ports/seeded-random-source-provider.js";
import type { ExerciseCompletionReason } from "../../domain/battle/outcome/exercise-end-policy.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";

export interface EvaluateTacticalExerciseCandidatesUseCaseDependencies {
  readonly battleCatalog: BattleCatalog;
  readonly battleIdGenerator: BattleIdGenerator;
  readonly clock: Clock;
  readonly seededRandomSourceProvider: SeededRandomSourceProvider;
  readonly limits: EvaluationLimits;
  readonly executionLimits?: SimulationExecutionLimits;
}

/**
 * 候補1件の評価結果。統計量ではなく試行ごとの生値を返す——集計・可視化は利用側の
 * 責務であり、どの統計を採るかをサーバーが先に決めてしまわないためである。
 */
export interface TacticalExerciseCandidateEvaluation {
  /** 期限到達で打ち切られた場合、要求した`runsPerCandidate`より小さくなる。 */
  readonly completedRuns: number;
  readonly scores: readonly number[];
  readonly breakCounts: readonly number[];
  readonly completedTurns: readonly number[];
  readonly completionReasons: readonly ExerciseCompletionReason[];
  /** 試行ごと・味方の参加枠ごとの与ダメージ合計。内側は候補の編成順。 */
  readonly allyUnitDamageTotals: readonly (readonly number[])[];
  /**
   * 試行ごと・味方の参加枠ごとの、その枠の攻撃で発生したブレイク回数。内側は編成順。
   * 数えるのは味方の枠が起こしたブレイクだけであり、内側の和は同じ添字の`breakCounts`
   * 以下になる。差は発生源が味方の枠でないブレイクの件数である。
   */
  readonly allyUnitBreakCounts: readonly (readonly number[])[];
}

export interface EvaluateTacticalExerciseCandidatesResult {
  readonly catalogRevision: string;
  readonly seed: string;
  readonly runsPerCandidate: number;
  readonly candidates: readonly TacticalExerciseCandidateEvaluation[];
}

/** 候補の味方編成と共有の敵編成から、単発の演習と同形のCommandを組み立てる。 */
function pairCommandFor(
  candidate: TacticalExerciseCandidateInput,
  command: EvaluateTacticalExerciseCandidatesCommand,
): FormationPairCommand {
  return { allyFormation: candidate.allyFormation, enemyFormation: command.enemyFormation };
}

function collectReferencedIds(command: EvaluateTacticalExerciseCandidatesCommand): {
  unitDefinitionIds: UnitDefinitionId[];
  memoryDefinitionIds: MemoryDefinitionId[];
} {
  const unitDefinitionIds = new Set<UnitDefinitionId>();
  const memoryDefinitionIds = new Set<MemoryDefinitionId>();

  for (const formation of [
    command.enemyFormation,
    ...command.candidates.map((candidate) => candidate.allyFormation),
  ]) {
    for (const slot of formation.slots) {
      unitDefinitionIds.add(slot.unitDefinitionId);
    }
    for (const memoryDefinitionId of formation.memoryDefinitionIds) {
      memoryDefinitionIds.add(memoryDefinitionId);
    }
  }

  return {
    unitDefinitionIds: [...unitDefinitionIds],
    memoryDefinitionIds: [...memoryDefinitionIds],
  };
}

/**
 * 全候補のpreflightを実行前にまとめて行う。1候補でも参照違反があれば1回も実行せずに
 * 返す——候補5件目の誤りのために先行4件を実行してから失敗すると、実行時間を捨てた
 * うえに「どの候補が悪いのか」が応答から読み取れないためである。
 */
function runCandidatePreflight(
  command: EvaluateTacticalExerciseCandidatesCommand,
  snapshot: BattleCatalogSnapshot,
): void {
  const notFound: Violation[] = [];
  const invalid: Violation[] = [];

  command.candidates.forEach((candidate, index) => {
    try {
      runPreflight(pairCommandFor(candidate, command), snapshot, "TACTICAL_EXERCISE");
      return;
    } catch (error) {
      if (!(error instanceof ApplicationError)) {
        throw error;
      }
      const violations = error.violations
        // 敵編成は全候補で同一であり違反も同一になるため、先頭の候補の分だけを残す。
        .filter((violation) => index === 0 || !violation.path?.startsWith("enemyFormation"))
        .map((violation) =>
          violation.path?.startsWith("allyFormation")
            ? { ...violation, path: `candidates[${index}].${violation.path}` }
            : violation,
        );
      (error.code === "DEFINITION_NOT_FOUND" ? notFound : invalid).push(...violations);
    }
  });

  if (notFound.length > 0) {
    // `runPreflight`と同じ優先順位: 未解決の参照を先に返す。解決済み定義を前提に
    // する検査（levelGrowth・カテゴリ）の結果を、存在しない定義に対して返さない。
    throw new ApplicationError("DEFINITION_NOT_FOUND", notFound);
  }
  if (invalid.length > 0) {
    throw new ApplicationError("INVALID_COMMAND", invalid);
  }
}

/**
 * `09_アプリケーション設計.md`「EvaluateTacticalExerciseCandidatesUseCase」。
 * 同じ敵に対する複数の味方編成を、それぞれ`runsPerCandidate`回の演習で評価する。
 *
 * 実行そのものは`SimulateTacticalExerciseUseCase`をそのまま呼ぶ。スコアの定義
 * （R-TEX-02）や演習の実行条件を単発エンドポイントと共有し、両者が食い違わない
 * ことをテストではなく構成で保証するためである。
 */
export class EvaluateTacticalExerciseCandidatesUseCase {
  private readonly dependencies: EvaluateTacticalExerciseCandidatesUseCaseDependencies;

  constructor(dependencies: EvaluateTacticalExerciseCandidatesUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  execute(
    command: EvaluateTacticalExerciseCandidatesCommand,
    context: SimulationExecutionContext,
  ): EvaluateTacticalExerciseCandidatesResult {
    const shapeViolations = validateEvaluateTacticalExerciseCandidatesCommandShape(
      command,
      this.dependencies.limits,
    );
    if (shapeViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const seed = command.seed;
    if (seed === undefined) {
      // seedの生成はInbound Adapterの責務。ユースケースは乱数源を持たず、
      // 同じCommandからは常に同じ結果を返す。
      throw new ApplicationError("INTERNAL_INVARIANT_VIOLATION", [
        { path: "seed", reason: "a seed must be resolved before the use case runs" },
      ]);
    }

    const referenced = collectReferencedIds(command);
    const snapshot = this.dependencies.battleCatalog.loadSnapshot(
      referenced.unitDefinitionIds,
      referenced.memoryDefinitionIds,
    );
    runCandidatePreflight(command, snapshot);

    const candidates = command.candidates.map((candidate) =>
      this.evaluateCandidate(candidate, command, seed, context),
    );

    return {
      catalogRevision: snapshot.catalogRevision,
      seed,
      runsPerCandidate: command.runsPerCandidate,
      candidates,
    };
  }

  private evaluateCandidate(
    candidate: TacticalExerciseCandidateInput,
    command: EvaluateTacticalExerciseCandidatesCommand,
    seed: string,
    context: SimulationExecutionContext,
  ): TacticalExerciseCandidateEvaluation {
    const scores: number[] = [];
    const breakCounts: number[] = [];
    const completedTurns: number[] = [];
    const completionReasons: ExerciseCompletionReason[] = [];
    const allyUnitDamageTotals: (readonly number[])[] = [];
    const allyUnitBreakCounts: (readonly number[])[] = [];

    for (let runIndex = 0; runIndex < command.runsPerCandidate; runIndex++) {
      if (this.dependencies.clock.now() >= context.deadlineEpochMs) {
        break;
      }

      let result;
      try {
        result = this.runOnce(candidate, command, seed, runIndex, context);
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "EXECUTION_TIMEOUT") {
          // 期限は個々の試行ではなくリクエスト全体に掛かる。途中で尽きた場合は
          // 完了済みの試行を捨てず、`completedRuns`で不足を示して返す。
          break;
        }
        throw error;
      }

      scores.push(result.totalScore);
      breakCounts.push(result.breakCount);
      completedTurns.push(result.completedTurn);
      completionReasons.push(result.completionReason);
      // 試行の結果そのものはここで捨て、ユニット別の生値だけを残す。
      const allyMetrics = projectAllyUnitRunMetrics(result);
      allyUnitDamageTotals.push(allyMetrics.damageTotals);
      allyUnitBreakCounts.push(allyMetrics.breakCounts);
    }

    return {
      completedRuns: scores.length,
      scores,
      breakCounts,
      completedTurns,
      completionReasons,
      allyUnitDamageTotals,
      allyUnitBreakCounts,
    };
  }

  private runOnce(
    candidate: TacticalExerciseCandidateInput,
    command: EvaluateTacticalExerciseCandidatesCommand,
    seed: string,
    runIndex: number,
    context: SimulationExecutionContext,
  ): SimulateTacticalExerciseResult {
    const { battleCatalog, battleIdGenerator, clock, seededRandomSourceProvider, executionLimits } =
      this.dependencies;

    // 乱数列は`runIndex`だけで決まる。候補indexを混ぜないため、候補が違っても
    // 同じ`runIndex`は同じ乱数列で評価される（共通乱数法）。
    const useCase = new SimulateTacticalExerciseUseCase({
      battleCatalog,
      battleIdGenerator,
      clock,
      randomSourceFactory: seededRandomSourceProvider.forRun(seed, runIndex),
      ...(executionLimits !== undefined ? { executionLimits } : {}),
    });

    return useCase.execute(
      {
        allyFormation: candidate.allyFormation,
        enemyFormation: command.enemyFormation,
        // イベント列・状態遷移・最終状態は返さないため、組み立てさせない。
        logLevel: "SUMMARY",
      },
      context,
    );
  }
}
