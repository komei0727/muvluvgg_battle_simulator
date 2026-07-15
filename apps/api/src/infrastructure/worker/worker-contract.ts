import {
  ApplicationError,
  type ApplicationErrorCode,
  type Violation,
} from "../../application/application-error.js";
import type { BattleSimulationRequestBody } from "../../application/http-contract.js";
import type { SimulateBattleResult } from "../../application/simulation-result-assembler.js";

/**
 * `11_インフラストラクチャ設計.md`「WorkerSimulationTask」: スレッド境界を渡す
 * 構造化クローン可能なplain object。関数、Symbol、HTTPオブジェクト、Domain
 * Entity、`Error`インスタンスを含めない。
 */
export interface WorkerSimulationTask {
  readonly requestId: string;
  readonly request: BattleSimulationRequestBody;
  readonly deadlineEpochMs: number;
  readonly expectedCatalogRevision: string;
}

/**
 * `ApplicationError`のplain object表現。`Error`インスタンスをそのまま
 * スレッド境界へ渡さず、ここへ変換してからやり取りする。
 */
export interface SerializedApplicationError {
  readonly code: ApplicationErrorCode;
  readonly violations: readonly Violation[];
  readonly diagnosticId?: string;
}

/** `11_インフラストラクチャ設計.md`「WorkerSimulationResult」。 */
export type WorkerSimulationResult =
  | { readonly ok: true; readonly result: SimulateBattleResult }
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
