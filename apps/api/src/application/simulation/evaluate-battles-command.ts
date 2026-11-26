import type { Violation } from "../contracts/application-error.js";
import {
  prefixViolationPaths,
  validateEvaluationRequestShape,
  type EvaluationRequestLimits,
  type EvaluationRequestShape,
} from "./evaluation-command.js";
import type { EvaluationCasePlan } from "./evaluation-runner.js";
import { validateCommandShape, type FormationInput } from "./simulate-battle-command.js";

/** 通常戦闘の大量試行の1ケース。両陣営と規定ターン数をケースごとに持つ。 */
export interface BattleEvaluationCaseInput extends EvaluationCasePlan {
  readonly allyFormation: FormationInput;
  readonly enemyFormation: FormationInput;
  readonly turnLimit: number;
}

/**
 * `09_アプリケーション設計.md`「EvaluateBattlesCommand」。`logLevel`は持たない — 生値の
 * 返却に必要な`SUMMARY`で実行し、イベント列・状態遷移は返さないためである。
 */
export interface EvaluateBattlesCommand extends EvaluationRequestShape {
  readonly cases: readonly BattleEvaluationCaseInput[];
}

/**
 * 既定値は実測から決めた（根拠は`11_インフラストラクチャ設計.md`「大量試行APIの実行境界」）。
 * production Catalogのメモリー最大構成（5対5・両陣営6メモリー）が1試行約45msで、300試行が
 * 本番Cloud Runの`SIMULATION_TIMEOUT_MS=30秒`の約45%に収まる。上限を超える要求や長期戦は
 * 期限到達で部分結果になるだけなので、上限は「返せる見込みのある量」に置く。この前提は
 * `LOAD-BEVAL-001`が固定する。
 */
export const DEFAULT_BATTLE_EVALUATION_LIMITS: EvaluationRequestLimits = {
  maxCases: 64,
  maxTotalRuns: 300,
};

/**
 * 共通の検証（seed・ケース・試行番号・要求量）に、各ケースへ単発の通常戦闘と同じ
 * Command検証（R-FRM-01～05、R-ENH-01、`turnLimit`1～99）を加える。
 */
export function validateEvaluateBattlesCommandShape(
  command: EvaluateBattlesCommand,
  limits: EvaluationRequestLimits,
): Violation[] {
  return [
    ...validateEvaluationRequestShape(command, limits),
    ...command.cases.flatMap((caseInput, caseIndex) =>
      prefixViolationPaths(
        validateCommandShape({
          allyFormation: caseInput.allyFormation,
          enemyFormation: caseInput.enemyFormation,
          turnLimit: caseInput.turnLimit,
          logLevel: "SUMMARY",
        }),
        `cases[${caseIndex}]`,
      ),
    ),
  ];
}
