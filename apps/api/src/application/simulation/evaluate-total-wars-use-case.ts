import { ApplicationError } from "../contracts/application-error.js";
import type { SimulationExecutionLimits } from "./battle-execution.js";
import type { EvaluationResultHeader } from "./evaluate-battles-use-case.js";
import {
  validateEvaluateTotalWarsCommandShape,
  type EvaluateTotalWarsCommand,
  type TotalWarEvaluationCaseInput,
} from "./evaluate-total-wars-command.js";
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
import { SimulateTotalWarUseCase } from "./simulate-total-war-use-case.js";
import type { SimulationExecutionContext } from "./simulation-execution-context.js";
import { runTotalWarPreflight } from "./simulation-preflight-validator.js";
import type { BattleCatalog } from "../../domain/ports/battle-catalog.js";
import type { BattleIdGenerator } from "../../domain/ports/battle-id-generator.js";
import type { Clock } from "../../domain/ports/clock.js";
import type { SeededRandomSourceProvider } from "../../domain/ports/seeded-random-source-provider.js";
import type { TotalWarStage } from "../../domain/battle/model/total-war-stages.js";
import type { CompletionReason } from "../../domain/battle/outcome/victory-policy.js";
import type { TotalWarOutcome } from "../../domain/battle/outcome/total-war-end-policy.js";

export interface EvaluateTotalWarsUseCaseDependencies {
  readonly battleCatalog: BattleCatalog;
  readonly battleIdGenerator: BattleIdGenerator;
  readonly clock: Clock;
  readonly seededRandomSourceProvider: SeededRandomSourceProvider;
  readonly runtimeInfo: EvaluationRuntimeInfo;
  readonly limits: EvaluationRequestLimits;
  readonly executionLimits?: SimulationExecutionLimits;
}

/**
 * 総力戦（勝ち抜き戦全体）1回の観測結果。ユニット別集計は総力戦全体の値であり、
 * ステージ別の値を推測して返さない。
 */
export interface TotalWarEvaluationRun {
  readonly outcome: TotalWarOutcome;
  readonly completionReason: CompletionReason;
  readonly completedTurn: number;
  readonly stages: readonly TotalWarStage[];
  readonly defeatedFormationCounts: { readonly ally: number; readonly enemy: number };
  /** 全編成の全参加枠。控えのまま終わった枠も`deployed: false`で含む。 */
  readonly units: readonly EvaluationUnitRecord[];
}

export interface EvaluateTotalWarsResult extends EvaluationResultHeader {
  readonly cases: readonly EvaluationCaseOutcome<TotalWarEvaluationRun>[];
}

/**
 * `09_アプリケーション設計.md`「EvaluateTotalWarsUseCase」。1試行は総力戦の勝ち抜き戦全体で
 * あり、乱数源を注入した`SimulateTotalWarUseCase`で全体を1回実行する。編成交代ごとに
 * 乱数を初期化したり、途中の各戦闘を独立した試行として扱ったりしない。
 */
export class EvaluateTotalWarsUseCase {
  private readonly dependencies: EvaluateTotalWarsUseCaseDependencies;

  constructor(dependencies: EvaluateTotalWarsUseCaseDependencies) {
    this.dependencies = dependencies;
  }

  execute(
    command: EvaluateTotalWarsCommand,
    context: SimulationExecutionContext,
  ): EvaluateTotalWarsResult {
    const { battleCatalog, clock, limits, runtimeInfo, seededRandomSourceProvider } =
      this.dependencies;

    const shapeViolations = validateEvaluateTotalWarsCommandShape(command, limits);
    if (shapeViolations.length > 0) {
      throw new ApplicationError("INVALID_COMMAND", shapeViolations);
    }

    const referenced = collectFormationReferences(
      command.cases.flatMap((caseInput) => [
        ...caseInput.allyFormations,
        ...caseInput.enemyFormations,
      ]),
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
    runCasesPreflight(command.cases, (caseInput) => runTotalWarPreflight(caseInput, snapshot));

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
    caseInput: TotalWarEvaluationCaseInput,
    seed: string,
    runIndex: number,
    context: SimulationExecutionContext,
  ): TotalWarEvaluationRun {
    const { battleCatalog, battleIdGenerator, clock, seededRandomSourceProvider, executionLimits } =
      this.dependencies;

    const result = new SimulateTotalWarUseCase({
      battleCatalog,
      battleIdGenerator,
      clock,
      randomSourceFactory: seededRandomSourceProvider.forRun(seed, runIndex),
      ...(executionLimits !== undefined ? { executionLimits } : {}),
    }).execute(
      {
        allyFormations: caseInput.allyFormations,
        enemyFormations: caseInput.enemyFormations,
        logLevel: "SUMMARY",
      },
      context,
    );

    return {
      outcome: result.outcome,
      completionReason: result.completionReason,
      completedTurn: result.completedTurn,
      stages: result.stages,
      defeatedFormationCounts: result.defeatedFormationCounts,
      units: projectEvaluationUnits(result.unitRoster, result.unitSummaries, {
        ALLY: caseInput.allyFormations,
        ENEMY: caseInput.enemyFormations,
      }),
    };
  }
}
