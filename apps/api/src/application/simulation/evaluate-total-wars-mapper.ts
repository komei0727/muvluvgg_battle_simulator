import {
  toEvaluationResponseHeaderBody,
  toEvaluationUnitRecordResponseBody,
} from "./evaluate-battles-mapper.js";
import type { EvaluateTotalWarsCommand } from "./evaluate-total-wars-command.js";
import type { EvaluateTotalWarsResult } from "./evaluate-total-wars-use-case.js";
import { toFormationInput } from "./simulate-battle-request-mapper.js";
import type { TotalWarEvaluationRequestBody } from "../contracts/request.js";
import type { TotalWarEvaluationResponseBody } from "../contracts/response.js";

/** 総力戦版の`toEvaluateBattlesCommand`。編成は出撃順のまま渡し、並べ替えない。 */
export function toEvaluateTotalWarsCommand(
  body: TotalWarEvaluationRequestBody,
): EvaluateTotalWarsCommand {
  return {
    seed: body.seed,
    cases: body.cases.map((caseBody) => ({
      caseId: caseBody.caseId,
      allyFormations: caseBody.allyFormations.map(toFormationInput),
      enemyFormations: caseBody.enemyFormations.map(toFormationInput),
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

/** `10_API設計.md`「TotalWarEvaluationResponse」への変換。統計量は算出しない。 */
export function toTotalWarEvaluationResponseBody(
  result: EvaluateTotalWarsResult,
): TotalWarEvaluationResponseBody {
  return {
    ...toEvaluationResponseHeaderBody(result),
    cases: result.cases.map((caseOutcome) => ({
      caseId: caseOutcome.caseId,
      runs: caseOutcome.runs.map(({ runIndex, result: run }) => ({
        runIndex,
        outcome: run.outcome,
        completionReason: run.completionReason,
        completedTurn: run.completedTurn,
        stages: run.stages.map((stage) => ({
          stageNumber: stage.stageNumber,
          allyFormationNumber: stage.allyFormationNumber,
          enemyFormationNumber: stage.enemyFormationNumber,
          startTurn: stage.startTurn,
          endTurn: stage.endTurn,
          defeatedSides: [...stage.defeatedSides],
        })),
        defeatedFormationCounts: {
          ally: run.defeatedFormationCounts.ally,
          enemy: run.defeatedFormationCounts.enemy,
        },
        units: run.units.map(toEvaluationUnitRecordResponseBody),
      })),
      incompleteRunIndices: [...caseOutcome.incompleteRunIndices],
    })),
  };
}
