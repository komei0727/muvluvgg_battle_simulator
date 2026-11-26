import { ApplicationError } from "../contracts/application-error.js";
import type { SimulationExecutionLimits } from "./battle-execution.js";
import {
  validateEvaluateBattlesCommandShape,
  type BattleEvaluationCaseInput,
  type EvaluateBattlesCommand,
} from "./evaluate-battles-command.js";
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
import { SimulateBattleUseCase } from "./simulate-battle-use-case.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import { runPreflight } from "./simulation-preflight-validator.js";
import type { BattleCatalog } from "../../domain/ports/battle-catalog.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";
import type { Clock } from "../../domain/ports/clock.js";
import type { SeededRandomSourceProvider } from "../../domain/ports/seeded-random-source-provider.js";
import type {
  BattleOutcome,
  CompletionReason,
} from "../../domain/battle/outcome/victory-policy.js";

export interface EvaluateBattlesUseCaseDependencies {
  readonly battleCatalog: BattleCatalog;
  readonly battleIdGenerator: BattleIdGenerator;
  readonly clock: Clock;
  readonly seededRandomSourceProvider: SeededRandomSourceProvider;
  readonly runtimeInfo: EvaluationRuntimeInfo;
  readonly limits: EvaluationRequestLimits;
  readonly executionLimits?: SimulationExecutionLimits;
}

/** 通常戦闘1回の観測結果。勝敗・終了理由は単発の通常戦闘の判定をそのまま使う。 */
export interface BattleEvaluationRun {
  readonly outcome: BattleOutcome;
  readonly completionReason: CompletionReason;
  readonly completedTurn: number;
  readonly units: readonly EvaluationUnitRecord[];
}

/** 大量試行に共通する、結果の再現条件と要求・完了の件数。 */
export interface EvaluationResultHeader {
  readonly seed: string;
  readonly seedDerivationVersion: string;
  readonly catalogRevision: string;
  readonly engineRevision: string;
  readonly requestedRuns: number;
  readonly completedRuns: number;
  readonly partial: boolean;
}

export interface EvaluateBattlesResult extends EvaluationResultHeader {
  readonly cases: readonly EvaluationCaseOutcome<BattleEvaluationRun>[];
}

/**
 * `09_アプリケーション設計.md`「EvaluateBattlesUseCase」。明示した対戦入力・seed・試行番号に
 * 対応する通常戦闘の観測結果を返す。統計・ランキングは利用側の責務とする。
 *
 * 実行は乱数源を注入した`SimulateBattleUseCase`をそのまま呼ぶ。勝敗・終了理由・集計の意味を
 * 単発エンドポイントと共有し、両者が食い違わないことを構成で保証するためである。
 */
export class EvaluateBattlesUseCase {
  private readonly dependencies: EvaluateBattlesUseCaseDependencies;

  constructor(dependencies: EvaluateBattlesUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  execute(
    command: EvaluateBattlesCommand,
    context: SimulationExecutionContext,
  ): EvaluateBattlesResult {
    const { battleCatalog, clock, limits, runtimeInfo, seededRandomSourceProvider } =
      this.dependencies;

    const shapeViolations = validateEvaluateBattlesCommandShape(command, limits);
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
    runCasesPreflight(command.cases, (caseInput) => runPreflight(caseInput, snapshot, "NORMAL"));

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
    caseInput: BattleEvaluationCaseInput,
    seed: string,
    runIndex: number,
    context: SimulationExecutionContext,
  ): BattleEvaluationRun {
    const { battleCatalog, battleIdGenerator, clock, seededRandomSourceProvider, executionLimits } =
      this.dependencies;

    // 乱数列は`(seed, runIndex)`だけで決まる。ケースID・ケース順・編成内容を混ぜないため、
    // 同じ試行番号を指定したケース間では同じ初期乱数列を使う。
    const result = new SimulateBattleUseCase({
      battleCatalog,
      battleIdGenerator,
      clock,
      randomSourceFactory: seededRandomSourceProvider.forRun(seed, runIndex),
      ...(executionLimits !== undefined ? { executionLimits } : {}),
    }).execute(
      {
        allyFormation: caseInput.allyFormation,
        enemyFormation: caseInput.enemyFormation,
        turnLimit: caseInput.turnLimit,
        logLevel: "SUMMARY",
      },
      context,
    );

    return {
      outcome: result.outcome,
      completionReason: result.completionReason,
      completedTurn: result.completedTurn,
      units: projectEvaluationUnits(result.unitRoster, result.unitSummaries, {
        ALLY: [caseInput.allyFormation],
        ENEMY: [caseInput.enemyFormation],
      }),
    };
  }
}
