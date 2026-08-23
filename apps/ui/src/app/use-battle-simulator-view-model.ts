import { useMemo } from "react";
import { selectCanSubmit } from "../features/formation/draft-validation.js";
import type { BattleDraft } from "../entities/battle-draft.js";
import type { UiViolation } from "../entities/violation.js";
import type { BattleSimulationCatalogResponse } from "../shared/api/api-contract.js";
import {
  selectDisplayedSuccess,
  selectIsCatalogRevisionMismatch,
  selectIsResultDirty,
} from "../features/simulation/execution-reducer.js";
import { mapServerViolationsToUiViolations } from "../features/simulation/violation-mapper.js";
import type { CatalogLoadState } from "../features/catalog-selection/catalog-loader.js";

import type { RequestBuildResult } from "../features/formation/request-mapper.js";
import type {
  ExecutionResponseLike,
  ExecutionState,
  SuccessfulExecutionSnapshot,
} from "../features/simulation/execution-reducer.js";

export interface BattleSimulatorViewModel<TRequest, TResponse extends ExecutionResponseLike> {
  /** draft単体の検証結果。`ValidationSummary`はサーバ由来を混ぜずこれだけを出す。 */
  readonly violations: readonly UiViolation[];
  /** draft検証 + 直近422のサーバ違反。slot単位の表示はこちらを使う。 */
  readonly displayedViolations: readonly UiViolation[];
  readonly requestBuild: RequestBuildResult<TRequest>;
  readonly isSubmitting: boolean;
  readonly canSubmit: boolean;
  readonly formationDisabled: boolean;
  readonly displayedSuccess: SuccessfulExecutionSnapshot<TRequest, TResponse> | undefined;
  readonly isDirty: boolean;
  readonly catalogRevisionMismatch: boolean;
}

export interface BattleSimulatorViewModelInput<TRequest, TResponse extends ExecutionResponseLike> {
  readonly catalog: CatalogLoadState;
  readonly draft: BattleDraft;
  readonly execution: ExecutionState<TRequest, TResponse>;
  /**
   * モード別の送信前検証とリクエスト生成。通常戦闘は`validateDraft`／
   * `buildBattleSimulationRequest`、戦術演習は`validateExerciseDraft`／
   * `buildTacticalExerciseRequest`（`UI-AC-020`、`UI-API-014`）。
   */
  readonly validate: (
    draft: BattleDraft,
    catalog: BattleSimulationCatalogResponse,
  ) => readonly UiViolation[];
  readonly buildRequest: (draft: BattleDraft) => RequestBuildResult<TRequest>;
}

/**
 * `BattleSimulatorPage` の描画に必要な派生値をまとめて導出する。状態そのものは
 * 3つのslice（catalog／formation／execution）が持ち、ここは純粋なselectorの合成
 * だけを担う（04_コンポーネント・状態管理設計.md §1・§4）。
 *
 * UI-CMP-013: モードごとに1回ずつ呼び、モード間で派生値を共有しない。
 */
export function useBattleSimulatorViewModel<TRequest, TResponse extends ExecutionResponseLike>({
  catalog,
  draft,
  execution,
  validate,
  buildRequest,
}: BattleSimulatorViewModelInput<TRequest, TResponse>): BattleSimulatorViewModel<
  TRequest,
  TResponse
> {
  const violations = useMemo(
    () => (catalog.status === "ready" ? validate(draft, catalog.response) : []),
    [catalog, draft, validate],
  );
  const requestBuild = useMemo(() => buildRequest(draft), [draft, buildRequest]);

  const serverViolations = useMemo(
    () =>
      execution.status === "failed" && execution.error.violations !== undefined
        ? mapServerViolationsToUiViolations(
            execution.error.violations,
            execution.allyUnitSlotKeys,
            execution.enemyUnitSlotKeys,
            execution.allyMemorySlotKeys,
            execution.enemyMemorySlotKeys,
            {
              ally: execution.allyGearSlotIndices,
              enemy: execution.enemyGearSlotIndices,
            },
          )
        : [],
    [execution],
  );

  const isSubmitting = execution.status === "submitting";
  const displayedSuccess = selectDisplayedSuccess(execution);

  return {
    violations,
    displayedViolations: [...violations, ...serverViolations],
    requestBuild,
    isSubmitting,
    canSubmit: catalog.status === "ready" && requestBuild.ok && selectCanSubmit(violations),
    formationDisabled: catalog.status !== "ready" || isSubmitting,
    displayedSuccess,
    isDirty: requestBuild.ok
      ? selectIsResultDirty(requestBuild.request, displayedSuccess?.request)
      : displayedSuccess !== undefined,
    catalogRevisionMismatch: selectIsCatalogRevisionMismatch(
      displayedSuccess,
      catalog.status === "ready" ? catalog.response.catalogRevision : undefined,
    ),
  };
}
