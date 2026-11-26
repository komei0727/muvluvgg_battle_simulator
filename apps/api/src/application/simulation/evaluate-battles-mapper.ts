import type { EvaluateBattlesCommand } from "./evaluate-battles-command.js";
import type { EvaluateBattlesResult, EvaluationResultHeader } from "./evaluate-battles-use-case.js";
import type { EvaluationUnitRecord } from "./evaluation-unit-records.js";
import { toFormationInput } from "./simulate-battle-request-mapper.js";
import { SCHEMA_VERSION } from "./simulate-battle-response-mapper.js";
import type { BattleEvaluationRequestBody } from "../contracts/request.js";
import type {
  BattleEvaluationResponseBody,
  EvaluationUnitRecordResponseBody,
} from "../contracts/response.js";

/**
 * `10_API設計.md`「Inbound Adapterでの変換」の大量試行版。編成の変換は単発の戦闘リクエストと
 * 共有する（`toFormationInput`）ため、各ケースの編成は単発と同じ意味を持つ。ユニットの配置・
 * 育成・メモリー順は並べ替えない。
 */
export function toEvaluateBattlesCommand(
  body: BattleEvaluationRequestBody,
): EvaluateBattlesCommand {
  return {
    seed: body.seed,
    cases: body.cases.map((caseBody) => ({
      caseId: caseBody.caseId,
      allyFormation: toFormationInput(caseBody.allyFormation),
      enemyFormation: toFormationInput(caseBody.enemyFormation),
      turnLimit: caseBody.turnLimit,
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

/** 通常戦闘・総力戦の大量試行に共通する応答ヘッダー。 */
export function toEvaluationResponseHeaderBody(result: EvaluationResultHeader) {
  return {
    schemaVersion: SCHEMA_VERSION,
    seed: result.seed,
    seedDerivationVersion: result.seedDerivationVersion,
    catalogRevision: result.catalogRevision,
    engineRevision: result.engineRevision,
    requestedRuns: result.requestedRuns,
    completedRuns: result.completedRuns,
    partial: result.partial,
  };
}

export function toEvaluationUnitRecordResponseBody(
  record: EvaluationUnitRecord,
): EvaluationUnitRecordResponseBody {
  return {
    side: record.side,
    ...(record.formationNumber !== undefined ? { formationNumber: record.formationNumber } : {}),
    unitIndex: record.unitIndex,
    unitDefinitionId: record.unitDefinitionId,
    damageDealt: record.damageDealt,
    damageTaken: record.damageTaken,
    healingDone: record.healingDone,
    finalHp: record.finalHp,
    maximumHp: record.maximumHp,
    combatStatus: record.combatStatus,
    ...(record.deployed !== undefined ? { deployed: record.deployed } : {}),
    ...(record.reappearance !== undefined ? { reappearance: record.reappearance } : {}),
  };
}

/** `10_API設計.md`「BattleEvaluationResponse」への変換。統計量は算出しない。 */
export function toBattleEvaluationResponseBody(
  result: EvaluateBattlesResult,
): BattleEvaluationResponseBody {
  return {
    ...toEvaluationResponseHeaderBody(result),
    cases: result.cases.map((caseOutcome) => ({
      caseId: caseOutcome.caseId,
      runs: caseOutcome.runs.map(({ runIndex, result: run }) => ({
        runIndex,
        outcome: run.outcome,
        completionReason: run.completionReason,
        completedTurn: run.completedTurn,
        units: run.units.map(toEvaluationUnitRecordResponseBody),
      })),
      incompleteRunIndices: [...caseOutcome.incompleteRunIndices],
    })),
  };
}
