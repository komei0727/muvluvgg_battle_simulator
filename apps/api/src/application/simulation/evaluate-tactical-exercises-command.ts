import type { Violation } from "../contracts/application-error.js";
import {
  prefixViolationPaths,
  validateEvaluationRequestShape,
  type EvaluationRequestLimits,
  type EvaluationRequestShape,
} from "./evaluation-command.js";
import type { EvaluationCasePlan } from "./evaluation-runner.js";
import { validateFormationShape, type FormationInput } from "./simulate-battle-command.js";
import { validateExerciseEnemyFormationShape } from "./simulate-tactical-exercise-command.js";

/**
 * 戦術演習の大量試行の1ケース。敵編成もケースごとに持つ — 1要求で別の演習敵に対する
 * 編成を並べて評価できるようにし、ケース間で入力の形を通常戦闘と揃えるためである。
 * 規定ターン数（R-TEX-01 #4）は演習で固定のため持たない。
 */
export interface TacticalExerciseEvaluationCaseInput extends EvaluationCasePlan {
  readonly allyFormation: FormationInput;
  readonly enemyFormation: FormationInput;
}

/**
 * `09_アプリケーション設計.md`「EvaluateTacticalExercisesCommand」。`logLevel`は持たない —
 * 返すのは試行ごとの数値だけで、イベント列・状態遷移は返さないためである。
 */
export interface EvaluateTacticalExercisesCommand extends EvaluationRequestShape {
  readonly cases: readonly TacticalExerciseEvaluationCaseInput[];
}

/**
 * 既定値は旧契約の`EVALUATION_MAX_CANDIDATES=32`・`EVALUATION_MAX_TOTAL_RUNS=300`を引き継ぐ。
 * 1試行が50〜70ms（production Catalogの演習敵、5対1）であり、本番Cloud Runの
 * `SIMULATION_TIMEOUT_MS=30秒`の7割に最も遅い敵で約300試行が収まる。上限を超える要求は
 * 期限到達で部分結果になるだけなので、上限は「返せる見込みのある量」に置く。この前提は
 * `LOAD-TEXEVAL-001`が固定する。
 */
export const DEFAULT_TACTICAL_EXERCISE_EVALUATION_LIMITS: EvaluationRequestLimits = {
  maxCases: 32,
  maxTotalRuns: 300,
};

/**
 * 共通の検証（seed・ケース・試行番号・要求量）に、各ケースへ単発の演習と同じ編成検証
 * （R-FRM-01～05、R-ENH-01、R-TEX-01 #3の敵ちょうど1体・敵メモリーなし）を加える。
 */
export function validateEvaluateTacticalExercisesCommandShape(
  command: EvaluateTacticalExercisesCommand,
  limits: EvaluationRequestLimits,
): Violation[] {
  return [
    ...validateEvaluationRequestShape(command, limits),
    ...command.cases.flatMap((caseInput, caseIndex) =>
      prefixViolationPaths(
        [
          ...validateFormationShape(caseInput.allyFormation, "allyFormation"),
          ...validateExerciseEnemyFormationShape(caseInput.enemyFormation, "enemyFormation"),
        ],
        `cases[${caseIndex}]`,
      ),
    ),
  ];
}
