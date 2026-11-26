import {
  toEvaluationResponseHeaderBody,
  toEvaluationUnitRecordResponseBody,
} from "./evaluate-battles-mapper.js";
import type { EvaluateTacticalExercisesCommand } from "./evaluate-tactical-exercises-command.js";
import type { EvaluateTacticalExercisesResult } from "./evaluate-tactical-exercises-use-case.js";
import { toFormationInput } from "./simulate-battle-request-mapper.js";
import type { TacticalExerciseEvaluationRequestBody } from "../contracts/request.js";
import type { TacticalExerciseEvaluationResponseBody } from "../contracts/response.js";

/**
 * `10_API設計.md`「Inbound Adapterでの変換」の大量試行版。編成の変換は単発の演習リクエストと
 * 共有する（`toFormationInput`）ため、各ケースの編成は単発と同じ意味を持つ。`seed`は
 * リクエストの値をそのまま使い、ここでも生成しない。
 */
export function toEvaluateTacticalExercisesCommand(
  body: TacticalExerciseEvaluationRequestBody,
): EvaluateTacticalExercisesCommand {
  return {
    seed: body.seed,
    cases: body.cases.map((caseBody) => ({
      caseId: caseBody.caseId,
      allyFormation: toFormationInput(caseBody.allyFormation),
      enemyFormation: toFormationInput(caseBody.enemyFormation),
      runIndices: [...caseBody.runIndices],
    })),
    ...(body.expectedCatalogRevision !== undefined
      ? { expectedCatalogRevision: body.expectedCatalogRevision }
      : {}),
    ...(body.expectedEngineRevision !== undefined
      ? { expectedEngineRevision: body.expectedEngineRevision }
      : {}),
  };
}

/** `10_API設計.md`「TacticalExerciseEvaluationResponse」への変換。統計量は算出しない。 */
export function toTacticalExerciseEvaluationResponseBody(
  result: EvaluateTacticalExercisesResult,
): TacticalExerciseEvaluationResponseBody {
  return {
    ...toEvaluationResponseHeaderBody(result),
    cases: result.cases.map((caseOutcome) => ({
      caseId: caseOutcome.caseId,
      runs: caseOutcome.runs.map(({ runIndex, result: run }) => ({
        runIndex,
        totalScore: run.totalScore,
        breakCount: run.breakCount,
        completionReason: run.completionReason,
        completedTurn: run.completedTurn,
        units: run.units.map(toEvaluationUnitRecordResponseBody),
        allyUnitBreaks: run.allyUnitBreaks.map((entry) => ({
          unitIndex: entry.unitIndex,
          unitDefinitionId: entry.unitDefinitionId,
          breakCount: entry.breakCount,
        })),
      })),
      incompleteRunIndices: [...caseOutcome.incompleteRunIndices],
    })),
  };
}
