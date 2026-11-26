import {
  ApplicationError,
  type ApplicationErrorCode,
  type Violation,
} from "../../application/contracts/application-error.js";
import type {
  BattleEvaluationRequestBody,
  BattleSimulationRequestBody,
  TacticalExerciseEvaluationRequestBody,
  TacticalExerciseRequestBody,
  TotalWarEvaluationRequestBody,
  TotalWarRequestBody,
} from "../../application/contracts/request.js";
import type { EvaluateBattlesResult } from "../../application/simulation/evaluate-battles-use-case.js";
import type { EvaluateTotalWarsResult } from "../../application/simulation/evaluate-total-wars-use-case.js";
import type { EvaluateTacticalExerciseCandidatesResult } from "../../application/simulation/evaluate-tactical-exercise-candidates-use-case.js";
import type {
  SimulateBattleResult,
  SimulateTacticalExerciseResult,
  SimulateTotalWarResult,
} from "../../application/simulation/simulation-result-assembler.js";

/**
 * `09_アプリケーション設計.md`「実行境界」: Workerタスクのモード判別子。既定値を
 * 持たせず、両モードとも明示的に指定させる — 判別子の省略を許すと、演習タスクが
 * 既定の戦闘として実行される取り違えが型の上で通ってしまう。
 */
export type WorkerSimulationMode =
  | "BATTLE_SIMULATION"
  | "TACTICAL_EXERCISE"
  | "TACTICAL_EXERCISE_EVALUATION"
  | "TOTAL_WAR"
  | "BATTLE_EVALUATION"
  | "TOTAL_WAR_EVALUATION";

interface WorkerSimulationTaskBase {
  readonly requestId: string;
  readonly deadlineEpochMs: number;
  readonly expectedCatalogRevision: string;
}

export interface WorkerBattleSimulationTask extends WorkerSimulationTaskBase {
  readonly mode: "BATTLE_SIMULATION";
  readonly request: BattleSimulationRequestBody;
}

/** R-TEX-01 #4: 演習リクエストは`turnLimit`を運ばない（規定ターン数は5固定）。 */
export interface WorkerTacticalExerciseTask extends WorkerSimulationTaskBase {
  readonly mode: "TACTICAL_EXERCISE";
  readonly request: TacticalExerciseRequestBody;
}

/**
 * `11_インフラストラクチャ設計.md`「WorkerSimulationTask」: スレッド境界を渡す
 * 構造化クローン可能なplain object。関数、Symbol、HTTPオブジェクト、Domain
 * Entity、`Error`インスタンスを含めない。タイムアウト・容量制御・Catalog
 * revision検査は両モードで同じ機構を共有する（`09_アプリケーション設計.md`「実行境界」）。
 */
/**
 * 候補×試行の二重ループは1タスクの内側で回す。`WORKER_MAX_QUEUE`は本番で1であり、
 * 試行ごとにタスクを投入するとキュー溢れ（503）になるためである。
 */
export interface WorkerTacticalExerciseEvaluationTask extends WorkerSimulationTaskBase {
  readonly mode: "TACTICAL_EXERCISE_EVALUATION";
  readonly request: TacticalExerciseEvaluationRequestBody;
}

/** R-TWR-01 #5: 総力戦リクエストも`turnLimit`を運ばない（規定ターン数は15固定）。 */
export interface WorkerTotalWarTask extends WorkerSimulationTaskBase {
  readonly mode: "TOTAL_WAR";
  readonly request: TotalWarRequestBody;
}

/**
 * 大量試行は1リクエストを1タスクで処理し、ケース×試行のループをタスクの内側で回す
 * （演習の一括評価と同じ理由: `WORKER_MAX_QUEUE`は本番で1である）。
 */
export interface WorkerBattleEvaluationTask extends WorkerSimulationTaskBase {
  readonly mode: "BATTLE_EVALUATION";
  readonly request: BattleEvaluationRequestBody;
}

/** 総力戦の大量試行。1試行は勝ち抜き戦全体である。 */
export interface WorkerTotalWarEvaluationTask extends WorkerSimulationTaskBase {
  readonly mode: "TOTAL_WAR_EVALUATION";
  readonly request: TotalWarEvaluationRequestBody;
}

export type WorkerSimulationTask =
  | WorkerBattleSimulationTask
  | WorkerTacticalExerciseTask
  | WorkerTacticalExerciseEvaluationTask
  | WorkerTotalWarTask
  | WorkerBattleEvaluationTask
  | WorkerTotalWarEvaluationTask;

/**
 * `ApplicationError`のplain object表現。`Error`インスタンスをそのまま
 * スレッド境界へ渡さず、ここへ変換してからやり取りする。
 */
export interface SerializedApplicationError {
  readonly code: ApplicationErrorCode;
  readonly violations: readonly Violation[];
  readonly diagnosticId?: string;
}

/**
 * `11_インフラストラクチャ設計.md`「WorkerSimulationResult」。成功結果はタスクと
 * 同じ判別子を持ち帰る — 呼び出し側が投入モードに対応する結果型
 * （`SimulateBattleResult`／`SimulateTacticalExerciseResult`）を、キャストではなく
 * 判別で取り出せるようにするためである。
 */
export type WorkerSimulationResult =
  | { readonly ok: true; readonly mode: "BATTLE_SIMULATION"; readonly result: SimulateBattleResult }
  | {
      readonly ok: true;
      readonly mode: "TACTICAL_EXERCISE";
      readonly result: SimulateTacticalExerciseResult;
    }
  | {
      readonly ok: true;
      readonly mode: "TACTICAL_EXERCISE_EVALUATION";
      readonly result: EvaluateTacticalExerciseCandidatesResult;
    }
  | { readonly ok: true; readonly mode: "TOTAL_WAR"; readonly result: SimulateTotalWarResult }
  | {
      readonly ok: true;
      readonly mode: "BATTLE_EVALUATION";
      readonly result: EvaluateBattlesResult;
    }
  | {
      readonly ok: true;
      readonly mode: "TOTAL_WAR_EVALUATION";
      readonly result: EvaluateTotalWarsResult;
    }
  | { readonly ok: false; readonly error: SerializedApplicationError };

export function toSerializedApplicationError(error: ApplicationError): SerializedApplicationError {
  return {
    code: error.code,
    violations: error.violations,
    ...(error.diagnosticId !== undefined ? { diagnosticId: error.diagnosticId } : {}),
  };
}

export function toApplicationError(serialized: SerializedApplicationError): ApplicationError {
  return new ApplicationError(serialized.code, serialized.violations, serialized.diagnosticId);
}
