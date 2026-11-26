import type { Violation } from "../contracts/application-error.js";
import {
  prefixViolationPaths,
  validateEvaluationRequestShape,
  type EvaluationRequestLimits,
  type EvaluationRequestShape,
} from "./evaluation-command.js";
import type { EvaluationCasePlan } from "./evaluation-runner.js";
import type { FormationInput } from "./simulate-battle-command.js";
import { validateTotalWarCommandShape } from "./simulate-total-war-command.js";

/**
 * 総力戦の大量試行の1ケース。各陣営の編成を出撃順に持ち、`turnLimit`は持たない
 * （R-TWR-01 #5、規定ターン数は固定）。
 */
export interface TotalWarEvaluationCaseInput extends EvaluationCasePlan {
  readonly allyFormations: readonly FormationInput[];
  readonly enemyFormations: readonly FormationInput[];
}

/** `09_アプリケーション設計.md`「EvaluateTotalWarsCommand」。 */
export interface EvaluateTotalWarsCommand extends EvaluationRequestShape {
  readonly cases: readonly TotalWarEvaluationCaseInput[];
}

/**
 * 既定値は実測から決めた（根拠は`11_インフラストラクチャ設計.md`「大量試行APIの実行境界」）。
 * 総力戦1試行は勝ち抜き戦全体（各陣営3編成×5体・6メモリーで約107ms）であり通常戦闘より
 * 重いため、通常戦闘の上限を転用しない。120試行が30秒の約45%に収まる。この前提は
 * `LOAD-TWEVAL-001`が固定する。
 */
export const DEFAULT_TOTAL_WAR_EVALUATION_LIMITS: EvaluationRequestLimits = {
  maxCases: 32,
  maxTotalRuns: 120,
};

/**
 * 共通の検証に、各ケースへ単発の総力戦と同じCommand検証（編成数1～3、R-FRM-01～05、
 * R-ENH-01、R-TWR-01の1編成内の重複）を加える。
 */
export function validateEvaluateTotalWarsCommandShape(
  command: EvaluateTotalWarsCommand,
  limits: EvaluationRequestLimits,
): Violation[] {
  return [
    ...validateEvaluationRequestShape(command, limits),
    ...command.cases.flatMap((caseInput, caseIndex) =>
      prefixViolationPaths(
        validateTotalWarCommandShape({
          allyFormations: caseInput.allyFormations,
          enemyFormations: caseInput.enemyFormations,
          logLevel: "SUMMARY",
        }),
        `cases[${caseIndex}]`,
      ),
    ),
  ];
}
