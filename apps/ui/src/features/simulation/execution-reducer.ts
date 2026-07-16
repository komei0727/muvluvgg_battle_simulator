// Mirrors docs/ui-design/04_コンポーネント・状態管理設計.md §4-5 (ExecutionState,
// BattleSimulatorAction「submission*」slice) and §6 (state transition table).

import type { BattleSimulationRequest } from "../formation/request-mapper.js";
import type { BattleSimulationResponse, UiApiError } from "./api-contract.js";

export interface SuccessfulExecutionSnapshot {
  readonly executionId: string;
  readonly request: BattleSimulationRequest;
  readonly response: BattleSimulationResponse;
  readonly requestId?: string;
  readonly completedAt: number;
}

export type ExecutionState =
  | { readonly status: "idle" }
  | {
      readonly status: "submitting";
      readonly executionId: string;
      readonly request: BattleSimulationRequest;
      readonly startedAt: number;
      // 送信時点のslot対応表(request-mapper.ts の allyUnitSlotKeys/
      // enemyUnitSlotKeys/allyMemorySlotKeys/enemyMemorySlotKeys)。failedへ
      // 引き継ぎ、422 violationsのJSON Pointerを現在のdraftではなく送信時の
      // slotへ対応づける(UI-API-004)。
      readonly allyUnitSlotKeys: readonly string[];
      readonly enemyUnitSlotKeys: readonly string[];
      readonly allyMemorySlotKeys: readonly string[];
      readonly enemyMemorySlotKeys: readonly string[];
      readonly previousSuccess?: SuccessfulExecutionSnapshot;
    }
  | {
      readonly status: "succeeded";
      readonly executionId: string;
      readonly request: BattleSimulationRequest;
      readonly response: BattleSimulationResponse;
      readonly requestId?: string;
      readonly completedAt: number;
    }
  | {
      readonly status: "failed";
      readonly executionId: string;
      readonly error: UiApiError;
      readonly requestId?: string;
      readonly allyUnitSlotKeys: readonly string[];
      readonly enemyUnitSlotKeys: readonly string[];
      readonly allyMemorySlotKeys: readonly string[];
      readonly enemyMemorySlotKeys: readonly string[];
      readonly previousSuccess?: SuccessfulExecutionSnapshot;
    }
  | {
      readonly status: "cancelled";
      readonly executionId: string;
      readonly previousSuccess?: SuccessfulExecutionSnapshot;
    };

export type ExecutionAction =
  | {
      readonly type: "submissionStarted";
      readonly executionId: string;
      readonly request: BattleSimulationRequest;
      readonly startedAt: number;
      readonly allyUnitSlotKeys: readonly string[];
      readonly enemyUnitSlotKeys: readonly string[];
      readonly allyMemorySlotKeys: readonly string[];
      readonly enemyMemorySlotKeys: readonly string[];
    }
  | {
      readonly type: "submissionSucceeded";
      readonly executionId: string;
      readonly response: BattleSimulationResponse;
      readonly requestId?: string;
      readonly completedAt: number;
    }
  | {
      readonly type: "submissionFailed";
      readonly executionId: string;
      readonly error: UiApiError;
      readonly requestId?: string;
    }
  | { readonly type: "submissionCancelled"; readonly executionId: string };

export function createInitialExecutionState(): ExecutionState {
  return { status: "idle" };
}

// The snapshot currently on screen: a fresh success, or one carried forward
// through a rerun that is submitting/failed/cancelled (UI-UC-005, UI-CMP-003).
function currentSuccessSnapshot(state: ExecutionState): SuccessfulExecutionSnapshot | undefined {
  switch (state.status) {
    case "succeeded":
      return {
        executionId: state.executionId,
        request: state.request,
        response: state.response,
        completedAt: state.completedAt,
        ...(state.requestId !== undefined ? { requestId: state.requestId } : {}),
      };
    case "submitting":
    case "failed":
    case "cancelled":
      return state.previousSuccess;
    case "idle":
      return undefined;
  }
}

export function executionReducer(state: ExecutionState, action: ExecutionAction): ExecutionState {
  switch (action.type) {
    case "submissionStarted": {
      const previousSuccess = currentSuccessSnapshot(state);
      return {
        status: "submitting",
        executionId: action.executionId,
        request: action.request,
        startedAt: action.startedAt,
        allyUnitSlotKeys: action.allyUnitSlotKeys,
        enemyUnitSlotKeys: action.enemyUnitSlotKeys,
        allyMemorySlotKeys: action.allyMemorySlotKeys,
        enemyMemorySlotKeys: action.enemyMemorySlotKeys,
        ...(previousSuccess !== undefined ? { previousSuccess } : {}),
      };
    }
    case "submissionSucceeded": {
      if (state.status !== "submitting" || state.executionId !== action.executionId) {
        return state;
      }
      return {
        status: "succeeded",
        executionId: action.executionId,
        request: state.request,
        response: action.response,
        completedAt: action.completedAt,
        ...(action.requestId !== undefined ? { requestId: action.requestId } : {}),
      };
    }
    case "submissionFailed": {
      if (state.status !== "submitting" || state.executionId !== action.executionId) {
        return state;
      }
      return {
        status: "failed",
        executionId: action.executionId,
        error: action.error,
        allyUnitSlotKeys: state.allyUnitSlotKeys,
        enemyUnitSlotKeys: state.enemyUnitSlotKeys,
        allyMemorySlotKeys: state.allyMemorySlotKeys,
        enemyMemorySlotKeys: state.enemyMemorySlotKeys,
        ...(action.requestId !== undefined ? { requestId: action.requestId } : {}),
        ...(state.previousSuccess !== undefined ? { previousSuccess: state.previousSuccess } : {}),
      };
    }
    case "submissionCancelled": {
      if (state.status !== "submitting" || state.executionId !== action.executionId) {
        return state;
      }
      return {
        status: "cancelled",
        executionId: action.executionId,
        ...(state.previousSuccess !== undefined ? { previousSuccess: state.previousSuccess } : {}),
      };
    }
  }
}

export function selectDisplayedSuccess(
  state: ExecutionState,
): SuccessfulExecutionSnapshot | undefined {
  return currentSuccessSnapshot(state);
}

// Deep-equality on the wire request is sufficient: buildBattleSimulationRequest
// produces stable key order and sorted arrays for the same draft
// (request-mapper.ts), so JSON.stringify is a safe structural comparison.
export function selectIsResultDirty(
  latestRequest: BattleSimulationRequest,
  displayedSuccessRequest: BattleSimulationRequest | undefined,
): boolean {
  if (displayedSuccessRequest === undefined) {
    return false;
  }
  return JSON.stringify(latestRequest) !== JSON.stringify(displayedSuccessRequest);
}

// Issue #96 受け入れ条件「Catalog revision不一致時に再取得・再選択を促す」。
// Catalog GETと戦闘POSTの間にサーバー側Catalogが切り替わった場合、
// definitionIdがまだ新Catalogに存在すればDEFINITION_NOT_FOUNDにならず成功
// responseが返る。その場合でも、保持中のCatalog(表示名・選択可否の解決元)
// とresponse.catalogRevisionが異なるなら、その結果は今表示しているCatalog
// と矛盾するため成功結果として表示してはならない。
//
// catalogRevisionがundefined(catalog.status !== "ready"、つまり再読込中・
// 再読込失敗後を含む)の場合もmismatch扱いにする——一度不一致を検出した後、
// 再読込がpending/failedの間だけ判定がfalseへ戻ると、確認が取れていない
// 古い結果が一時的に再表示されてしまう(PRレビュー指摘)。
export function selectIsCatalogRevisionMismatch(
  displayedSuccess: SuccessfulExecutionSnapshot | undefined,
  catalogRevision: string | undefined,
): boolean {
  if (displayedSuccess === undefined) {
    return false;
  }
  return displayedSuccess.response.catalogRevision !== catalogRevision;
}
