import {
  ApplicationError,
  type ApplicationErrorCode,
  type Violation,
} from "../../application/contracts/application-error.js";
import type {
  BattleSimulationRequestBody,
  TacticalExerciseRequestBody,
} from "../../application/contracts/request.js";
import type {
  SimulateBattleResult,
  SimulateTacticalExerciseResult,
} from "../../application/simulation/simulation-result-assembler.js";

/**
 * `09_アプリケーション設計.md`「実行境界」: Workerタスクのモード判別子。既定値を
 * 持たせず、両モードとも明示的に指定させる — 判別子の省略を許すと、演習タスクが
 * 既定の戦闘として実行される取り違えが型の上で通ってしまう。
 */
export type WorkerSimulationMode = "BATTLE_SIMULATION" | "TACTICAL_EXERCISE";

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
export type WorkerSimulationTask = WorkerBattleSimulationTask | WorkerTacticalExerciseTask;

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
