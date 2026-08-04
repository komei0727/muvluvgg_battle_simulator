import { useMemo } from "react";
import { selectCanSubmit, validateDraft } from "../features/formation/draft-validation.js";
import { buildBattleSimulationRequest } from "../features/formation/request-mapper.js";
import {
  selectDisplayedSuccess,
  selectIsCatalogRevisionMismatch,
  selectIsResultDirty,
} from "../features/simulation/execution-reducer.js";
import { mapServerViolationsToUiViolations } from "../features/simulation/violation-mapper.js";
import type { CatalogLoadState } from "../features/catalog-selection/catalog-loader.js";
import type { UiViolation } from "../features/formation/draft-validation.js";
import type { BattleDraft } from "../features/formation/types.js";
import type { RequestBuildResult } from "../features/formation/request-mapper.js";
import type {
  ExecutionState,
  SuccessfulExecutionSnapshot,
} from "../features/simulation/execution-reducer.js";

export interface BattleSimulatorViewModel {
  /** draft単体の検証結果。`ValidationSummary`はサーバ由来を混ぜずこれだけを出す。 */
  readonly violations: readonly UiViolation[];
  /** draft検証 + 直近422のサーバ違反。slot単位の表示はこちらを使う。 */
  readonly displayedViolations: readonly UiViolation[];
  readonly requestBuild: RequestBuildResult;
  readonly isSubmitting: boolean;
  readonly canSubmit: boolean;
  readonly formationDisabled: boolean;
  readonly displayedSuccess: SuccessfulExecutionSnapshot | undefined;
  readonly isDirty: boolean;
  readonly catalogRevisionMismatch: boolean;
}

export interface BattleSimulatorViewModelInput {
  readonly catalog: CatalogLoadState;
  readonly draft: BattleDraft;
  readonly execution: ExecutionState;
}

/**
 * `BattleSimulatorPage` の描画に必要な派生値をまとめて導出する。状態そのものは
 * 3つのslice（catalog／formation／execution）が持ち、ここは純粋なselectorの合成
 * だけを担う（04_コンポーネント・状態管理設計.md §1・§4）。
 */
export function useBattleSimulatorViewModel({
  catalog,
  draft,
  execution,
}: BattleSimulatorViewModelInput): BattleSimulatorViewModel {
  const violations = useMemo(
    () => (catalog.status === "ready" ? validateDraft(draft, catalog.response) : []),
    [catalog, draft],
  );
  const requestBuild = useMemo(() => buildBattleSimulationRequest(draft), [draft]);

  const serverViolations = useMemo(
    () =>
      execution.status === "failed" && execution.error.violations !== undefined
        ? mapServerViolationsToUiViolations(
            execution.error.violations,
            execution.allyUnitSlotKeys,
            execution.enemyUnitSlotKeys,
            execution.allyMemorySlotKeys,
            execution.enemyMemorySlotKeys,
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
