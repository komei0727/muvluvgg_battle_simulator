import type { EvaluateTacticalExerciseCandidatesCommand } from "./evaluate-tactical-exercise-candidates-command.js";
import type { EvaluateTacticalExerciseCandidatesResult } from "./evaluate-tactical-exercise-candidates-use-case.js";
import { toFormationInput } from "./simulate-battle-request-mapper.js";
import { SCHEMA_VERSION } from "./simulate-battle-response-mapper.js";
import type { TacticalExerciseEvaluationRequestBody } from "../contracts/request.js";
import type { TacticalExerciseEvaluationResponseBody } from "../contracts/response.js";

/**
 * `10_API設計.md`「Inbound Adapterでの変換」の一括評価版。編成の変換は戦闘リクエストと
 * 共有する（`toFormationInput`）ため、候補の編成は単発の演習とまったく同じ意味を持つ。
 *
 * `seed`はここで確定させる。ユースケースは乱数源を持たず、同じCommandからは常に同じ
 * 結果を返す契約であるため、省略時の生成はInbound Adapterの責務である。
 */
export function toEvaluateTacticalExerciseCandidatesCommand(
  body: TacticalExerciseEvaluationRequestBody,
  fallbackSeed: string,
): EvaluateTacticalExerciseCandidatesCommand {
  return {
    enemyFormation: toFormationInput(body.enemyFormation),
    candidates: body.candidates.map((candidate) => ({
      allyFormation: toFormationInput(candidate.allyFormation),
    })),
    runsPerCandidate: body.runsPerCandidate,
    seed: body.seed ?? fallbackSeed,
  };
}

/**
 * `10_API設計.md`「TacticalExerciseEvaluationResponse」への変換。試行ごとの生値を
 * そのまま写すだけで、統計量は算出しない。
 */
export function toTacticalExerciseEvaluationResponseBody(
  result: EvaluateTacticalExerciseCandidatesResult,
): TacticalExerciseEvaluationResponseBody {
  return {
    schemaVersion: SCHEMA_VERSION,
    catalogRevision: result.catalogRevision,
    seed: result.seed,
    runsPerCandidate: result.runsPerCandidate,
    candidates: result.candidates.map((candidate) => ({
      completedRuns: candidate.completedRuns,
      scores: [...candidate.scores],
      breakCounts: [...candidate.breakCounts],
      completedTurns: [...candidate.completedTurns],
      completionReasons: [...candidate.completionReasons],
      allyUnitDamageTotals: candidate.allyUnitDamageTotals.map((totals) => [...totals]),
      allyUnitBreakCounts: candidate.allyUnitBreakCounts.map((counts) => [...counts]),
    })),
  };
}
