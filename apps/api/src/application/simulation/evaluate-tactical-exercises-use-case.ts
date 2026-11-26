import { ApplicationError } from "../contracts/application-error.js";
import { projectAllyUnitBreaks, type AllyUnitBreakCount } from "./ally-unit-run-metrics.js";
import type { SimulationExecutionLimits } from "./battle-execution.js";
import type { EvaluationResultHeader } from "./evaluate-battles-use-case.js";
import {
  validateEvaluateTacticalExercisesCommandShape,
  type EvaluateTacticalExercisesCommand,
  type TacticalExerciseEvaluationCaseInput,
} from "./evaluate-tactical-exercises-command.js";
import {
  collectFormationReferences,
  runCasesPreflight,
  type EvaluationRequestLimits,
} from "./evaluation-command.js";
import { runEvaluationSchedule, type EvaluationCaseOutcome } from "./evaluation-runner.js";
import {
  validateExpectedRevisions,
  type EvaluationRuntimeInfo,
} from "./evaluation-runtime-info.js";
import { projectEvaluationUnits, type EvaluationUnitRecord } from "./evaluation-unit-records.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import { runPreflight } from "./simulation-preflight-validator.js";
import { SimulateTacticalExerciseUseCase } from "./simulate-tactical-exercise-use-case.js";
import type { BattleCatalog } from "../../domain/ports/battle-catalog.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";
import type { Clock } from "../../domain/ports/clock.js";
import type { SeededRandomSourceProvider } from "../../domain/ports/seeded-random-source-provider.js";
import type { ExerciseCompletionReason } from "../../domain/battle/outcome/exercise-end-policy.js";

export interface EvaluateTacticalExercisesUseCaseDependencies {
  readonly battleCatalog: BattleCatalog;
  readonly battleIdGenerator: BattleIdGenerator;
  readonly clock: Clock;
  readonly seededRandomSourceProvider: SeededRandomSourceProvider;
  readonly runtimeInfo: EvaluationRuntimeInfo;
  readonly limits: EvaluationRequestLimits;
  readonly executionLimits?: SimulationExecutionLimits;
}

/**
 * 演習1回の観測結果。スコア・終了理由は単発の演習の値をそのまま使い、通常戦闘の勝敗や
 * 総力戦のDRAWへ読み替えない。
 */
export interface TacticalExerciseEvaluationRun {
  readonly totalScore: number;
  readonly breakCount: number;
  readonly completionReason: ExerciseCompletionReason;
  readonly completedTurn: number;
  readonly units: readonly EvaluationUnitRecord[];
  /**
   * 味方の参加枠ごとの、その枠が起こしたブレイク回数。和は`breakCount`以下になり、差は
   * 発生源が味方の枠でないブレイク（メモリー由来・敵の自傷など）の件数である。
   */
  readonly allyUnitBreaks: readonly AllyUnitBreakCount[];
}

export interface EvaluateTacticalExercisesResult extends EvaluationResultHeader {
  readonly cases: readonly EvaluationCaseOutcome<TacticalExerciseEvaluationRun>[];
}

/**
 * `09_アプリケーション設計.md`「EvaluateTacticalExercisesUseCase」。明示した対戦入力・seed・
 * 試行番号に対応する演習の観測結果を返す。統計・ランキングは利用側の責務とする。
 *
 * 実行は乱数源を注入した`SimulateTacticalExerciseUseCase`をそのまま呼ぶ。スコアの定義
 * （R-TEX-02）や演習の実行条件を単発エンドポイントと共有し、両者が食い違わないことを
 * 構成で保証するためである。
 */
export class EvaluateTacticalExercisesUseCase {
  private readonly dependencies: EvaluateTacticalExercisesUseCaseDependencies;

  constructor(dependencies: EvaluateTacticalExercisesUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  execute(
    command: EvaluateTacticalExercisesCommand,
    context: SimulationExecutionContext,
  ): EvaluateTacticalExercisesResult {
    const { battleCatalog, clock, limits, runtimeInfo, seededRandomSourceProvider } =
      this.dependencies;

    const shapeViolations = validateEvaluateTacticalExercisesCommandShape(command, limits);
    if (shapeViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const referenced = collectFormationReferences(
      command.cases.flatMap((caseInput) => [caseInput.allyFormation, caseInput.enemyFormation]),
    );
    const snapshot = battleCatalog.loadSnapshot(
      referenced.unitDefinitionIds,
      referenced.memoryDefinitionIds,
    );
    const revisionViolations = validateExpectedRevisions(command, {
      catalogRevision: snapshot.catalogRevision,
      engineRevision: runtimeInfo.engineRevision,
    });
    if (revisionViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", revisionViolations);
    }
    runCasesPreflight(command.cases, (caseInput) =>
      runPreflight(caseInput, snapshot, "TACTICAL_EXERCISE"),
    );

    const schedule = runEvaluationSchedule(command.cases, {
      clock,
      deadlineEpochMs: context.deadlineEpochMs,
      runTrial: (caseInput, runIndex) => this.runOnce(caseInput, command.seed, runIndex, context),
    });

    return {
      seed: command.seed,
      seedDerivationVersion: seededRandomSourceProvider.derivationVersion,
      catalogRevision: snapshot.catalogRevision,
      engineRevision: runtimeInfo.engineRevision,
      requestedRuns: schedule.requestedRuns,
      completedRuns: schedule.completedRuns,
      partial: schedule.partial,
      cases: schedule.cases,
    };
  }

  private runOnce(
    caseInput: TacticalExerciseEvaluationCaseInput,
    seed: string,
    runIndex: number,
    context: SimulationExecutionContext,
  ): TacticalExerciseEvaluationRun {
    const { battleCatalog, battleIdGenerator, clock, seededRandomSourceProvider, executionLimits } =
      this.dependencies;

    // 乱数列は`(seed, runIndex)`だけで決まる。ケースID・ケース順・チャンク番号を混ぜないため、
    // 同じ試行番号を指定したケース間では同じ初期乱数列を使い（共通乱数法）、要求を分割・
    // 再送しても同じ試行番号は同じ観測になる。
    const result = new SimulateTacticalExerciseUseCase({
      battleCatalog,
      battleIdGenerator,
      clock,
      randomSourceFactory: seededRandomSourceProvider.forRun(seed, runIndex),
      ...(executionLimits !== undefined ? { executionLimits } : {}),
    }).execute(
      {
        allyFormation: caseInput.allyFormation,
        enemyFormation: caseInput.enemyFormation,
        // イベント列・状態遷移・最終状態は返さないため、組み立てさせない。
        logLevel: "SUMMARY",
      },
      context,
    );

    return {
      totalScore: result.totalScore,
      breakCount: result.breakCount,
      completionReason: result.completionReason,
      completedTurn: result.completedTurn,
      units: projectEvaluationUnits(result.unitRoster, result.unitSummaries, {
        ALLY: [caseInput.allyFormation],
        ENEMY: [caseInput.enemyFormation],
      }),
      allyUnitBreaks: projectAllyUnitBreaks(result),
    };
  }
}
