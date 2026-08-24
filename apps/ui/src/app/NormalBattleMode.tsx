import { useCallback, useMemo, useReducer } from "react";
import { Panel } from "../components/Panel.js";
import { BattleDetailsSection } from "../features/details/BattleDetailsSection.js";
import type { CatalogLoadState } from "../features/catalog-selection/catalog-loader.js";
import {
  definitionImageMap,
  memoryImageMap,
  unitImageMap,
} from "../features/catalog-selection/definition-image-map.js";
import { validateDraft } from "../features/formation/draft-validation.js";
import { withPlayerEnhancement } from "../features/formation/effective-draft.js";
import { BattleSetupLayout } from "../features/formation/BattleSetupLayout.js";
import { ExecutionParameterForm } from "../features/formation/ExecutionParameterForm.js";
import { FormationEditor } from "../features/formation/FormationEditor.js";
import { FormationResetControls } from "../features/formation/FormationResetControls.js";
import { formationReducer } from "../features/formation/formation-reducer.js";
import type { SelectionDialogState } from "../features/formation/formation-reducer.js";
import { LAST_DRAFT_STORAGE_KEY } from "../features/formation/persistence.js";
import type { PlayerEnhancementPersistence } from "../features/formation/use-player-enhancement-persistence.js";
import {
  createPersistedInitialState,
  usePersistedDraft,
} from "../features/formation/use-formation-persistence.js";
import type { UseFormationStatPreviewOptions } from "../features/formation/use-formation-stat-preview.js";
import { useFormationStatPreview } from "../features/formation/use-formation-stat-preview.js";
import { buildBattleSimulationRequest } from "../features/formation/request-mapper.js";
import { SubmitControls } from "../features/formation/SubmitControls.js";
import { StatPreviewModeToggle } from "../features/formation/StatPreviewModeToggle.js";
import {
  canOpenUnitEnhancementDialog,
  enhancementForSide,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import { ValidationSummary } from "../features/formation/ValidationSummary.js";
import { SubmissionFeedback } from "../features/simulation/SubmissionFeedback.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import { useSimulationExecution } from "../features/simulation/use-simulation-execution.js";
import { BattleSummarySection } from "../features/summary/BattleSummarySection.js";
import { describeBattleResult } from "../features/summary/summary-projector.js";
import { OutcomeStrip } from "../features/summary/OutcomeStrip.js";

import { SelectionDialogs } from "./SelectionDialogs.js";
import { useBattleSimulatorViewModel } from "./use-battle-simulator-view-model.js";

const SIMULATION_ENDPOINT = "POST /api/v1/battle-simulations";

export interface NormalBattleModeProps {
  /**
   * REF-059: モードタブ切替でもコンテナ自体はアンマウントしない（`BattleSimulatorPage`
   * が両モードのコンテナを常時描画し続ける）。実行状態・統計実行はlocalStorageへ
   * 永続化されないため、アンマウントすると再マウント時に消える
   * （`UI-CT-032`：他モードへ切替えて戻っても直近結果を保持する）。`active`はJSX描画の
   * 出し分けにだけ使い、hookは常に呼ぶ。
   */
  readonly active: boolean;
  readonly apiBaseUrl: string;
  readonly catalog: CatalogLoadState;
  readonly onReloadCatalog: () => void;
  readonly showBaseStats: boolean;
  readonly onShowBaseStatsChange: (value: boolean) => void;
  readonly playerEnhancement: PlayerEnhancementPersistence;
  readonly selectionDialog: SelectionDialogState;
  readonly onRequestSelectionDialog: (
    selection: Exclude<SelectionDialogState, { kind: "closed" }>,
  ) => void;
  readonly onCloseSelectionDialog: () => void;
  readonly simulateImpl?: UseSimulationExecutionOptions["simulateImpl"];
  readonly previewFormationStatsImpl?: UseFormationStatPreviewOptions["previewImpl"];
}

/**
 * 通常戦闘モード。編成draft・実行状態・送信前検証を自身のsliceとして持つ
 * （REF-059 / Issue #604）。味方の学園レベル・レベルリンク・ユニット強化と
 * ダイアログ選択状態はモードに依らないため`BattleSimulatorPage`から受け取る。
 */
export function NormalBattleMode({
  active,
  apiBaseUrl,
  catalog,
  onReloadCatalog,
  showBaseStats,
  onShowBaseStatsChange,
  playerEnhancement,
  selectionDialog,
  onRequestSelectionDialog,
  onCloseSelectionDialog,
  simulateImpl,
  previewFormationStatsImpl,
}: NormalBattleModeProps) {
  const [battleState, dispatch] = useReducer(
    formationReducer,
    LAST_DRAFT_STORAGE_KEY,
    createPersistedInitialState,
  );
  const effectiveDraft = useMemo(
    () => withPlayerEnhancement(battleState.draft, playerEnhancement.state),
    [battleState.draft, playerEnhancement.state],
  );

  const execution = useSimulationExecution(
    apiBaseUrl,
    simulateImpl !== undefined ? { simulateImpl } : {},
  );

  const view = useBattleSimulatorViewModel({
    catalog,
    draft: effectiveDraft,
    execution: execution.state,
    validate: validateDraft,
    buildRequest: buildBattleSimulationRequest,
  });

  usePersistedDraft({
    storageKey: LAST_DRAFT_STORAGE_KEY,
    draft: battleState.draft,
    catalog,
    violations: view.violations,
    dispatch,
  });

  // UI-AC-027: 非活性モードは裏で編成状態プレビューを取得し続けない（`enabled: active`）。
  const statPreview = useFormationStatPreview(apiBaseUrl, effectiveDraft, {
    mode: "NORMAL",
    enabled: active,
    ...(previewFormationStatsImpl !== undefined ? { previewImpl: previewFormationStatsImpl } : {}),
  });

  const resetDraft = useCallback(() => {
    dispatch({ type: "draftReset" });
  }, [dispatch]);

  const openSelection = useCallback(
    (selection: Exclude<SelectionDialogState, { kind: "closed" }>) => {
      if (
        selection.kind === "unitEnhancement" &&
        !canOpenUnitEnhancementDialog(effectiveDraft, selection.slotKey)
      ) {
        return;
      }
      onRequestSelectionDialog(selection);
    },
    [effectiveDraft, onRequestSelectionDialog],
  );

  const submit = () => {
    if (view.requestBuild.ok) {
      const { ok: _ok, ...input } = view.requestBuild;
      execution.submit(input);
    }
  };

  if (!active) {
    return null;
  }

  return (
    <>
      <div role="tabpanel" id="tabpanel-battle" aria-labelledby="tab-battle">
        <Panel step="01" title="戦闘パラメータ" meta="FORMATION / MEMORY / EXECUTION">
          {catalog.status === "loading" ? <p>Catalogを読込中…</p> : null}
          {catalog.status === "failed" ? (
            <div role="alert">
              <p>{catalog.error.message}</p>
              <button type="button" onClick={onReloadCatalog}>
                再読込
              </button>
            </div>
          ) : null}

          {catalog.status === "ready" ? (
            <>
              <StatPreviewModeToggle
                showBaseStats={showBaseStats}
                onChange={onShowBaseStatsChange}
              />

              <BattleSetupLayout
                ally={
                  <FormationEditor
                    side="ally"
                    slots={slotsForSide(effectiveDraft, "ally")}
                    memoryDefinitionIds={memorySlotsForSide(effectiveDraft, "ally")}
                    catalog={catalog.response}
                    violations={view.displayedViolations}
                    disabled={view.formationDisabled}
                    imageMap={definitionImageMap}
                    enhancement={enhancementForSide(effectiveDraft, "ally")}
                    statPreview={statPreview}
                    showBaseStats={showBaseStats}
                    onOpenUnitSelection={(slotKey) => {
                      openSelection({ kind: "unit", slotKey });
                    }}
                    onOpenMemorySelection={(side, index) => {
                      openSelection({ kind: "memory", side, index });
                    }}
                    onOpenUnitEnhancement={(slotKey) => {
                      openSelection({ kind: "unitEnhancement", slotKey });
                    }}
                    onEnhancementToggle={(side, enabled) => {
                      dispatch({ type: "enhancementToggled", side, enabled });
                    }}
                    onAcademyLevelChange={(_side, group, key, value) => {
                      playerEnhancement.dispatch({
                        type: "academyLevelChanged",
                        group,
                        key,
                        value,
                      });
                    }}
                    onLevelLinkToggle={(_side, enabled) => {
                      playerEnhancement.dispatch({ type: "levelLinkToggled", enabled });
                    }}
                    onLevelLinkChange={(_side, value) => {
                      playerEnhancement.dispatch({ type: "levelLinkLevelChanged", value });
                    }}
                    onMoveUnit={(fromSlotKey, toSlotKey) => {
                      dispatch({ type: "unitMoved", fromSlotKey, toSlotKey });
                    }}
                  />
                }
                enemy={
                  <FormationEditor
                    side="enemy"
                    slots={slotsForSide(effectiveDraft, "enemy")}
                    memoryDefinitionIds={memorySlotsForSide(effectiveDraft, "enemy")}
                    catalog={catalog.response}
                    violations={view.displayedViolations}
                    disabled={view.formationDisabled}
                    imageMap={definitionImageMap}
                    enhancement={enhancementForSide(effectiveDraft, "enemy")}
                    statPreview={statPreview}
                    showBaseStats={showBaseStats}
                    onOpenUnitSelection={(slotKey) => {
                      openSelection({ kind: "unit", slotKey });
                    }}
                    onOpenMemorySelection={(side, index) => {
                      openSelection({ kind: "memory", side, index });
                    }}
                    onOpenUnitEnhancement={(slotKey) => {
                      openSelection({ kind: "unitEnhancement", slotKey });
                    }}
                    onEnhancementToggle={(side, enabled) => {
                      dispatch({ type: "enhancementToggled", side, enabled });
                    }}
                    onAcademyLevelChange={(side, group, key, value) => {
                      dispatch({ type: "academyLevelChanged", side, group, key, value });
                    }}
                    onLevelLinkToggle={(side, enabled) => {
                      dispatch({ type: "levelLinkToggled", side, enabled });
                    }}
                    onLevelLinkChange={(side, value) => {
                      dispatch({ type: "levelLinkLevelChanged", side, value });
                    }}
                    onMoveUnit={(fromSlotKey, toSlotKey) => {
                      dispatch({ type: "unitMoved", fromSlotKey, toSlotKey });
                    }}
                  />
                }
              />

              <ExecutionParameterForm
                turnLimit={effectiveDraft.turnLimit}
                logLevel={effectiveDraft.logLevel}
                endpoint={SIMULATION_ENDPOINT}
                disabled={view.formationDisabled}
                violations={view.displayedViolations}
                onTurnLimitChange={(value) => {
                  dispatch({ type: "turnLimitChanged", value });
                }}
                onLogLevelChange={(value) => {
                  dispatch({ type: "logLevelChanged", value });
                }}
              />

              <ValidationSummary violations={view.violations} />

              <SubmitControls
                canSubmit={view.canSubmit}
                isSubmitting={view.isSubmitting}
                submitLabel="戦闘を開始"
                onSubmit={submit}
                onCancel={execution.cancel}
              />

              <FormationResetControls
                disabled={view.formationDisabled}
                onResetDraft={resetDraft}
                onClearPlayerData={() => {
                  playerEnhancement.dispatch({ type: "cleared" });
                }}
              />
            </>
          ) : null}
        </Panel>

        <SubmissionFeedback
          state={execution.state}
          isDirty={view.isDirty}
          successMessage="戦闘が完了しました。"
          resultSummary={
            view.displayedSuccess === undefined
              ? ""
              : describeBattleResult(view.displayedSuccess.response.result)
          }
          catalogRevisionMismatch={view.catalogRevisionMismatch}
          onReloadCatalog={onReloadCatalog}
        />

        {view.displayedSuccess !== undefined && !view.catalogRevisionMismatch ? (
          <>
            <Panel step="02" title="戦闘サマリ" meta="OUTCOME / ROSTER">
              <BattleSummarySection
                response={view.displayedSuccess.response}
                {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
                header={
                  <OutcomeStrip
                    result={view.displayedSuccess.response.result}
                    turnLimit={view.displayedSuccess.request.turnLimit}
                    battleId={view.displayedSuccess.response.battleId}
                    catalogRevision={view.displayedSuccess.response.catalogRevision}
                  />
                }
                imageMap={unitImageMap}
              />
            </Panel>
            <Panel step="03" title="戦闘詳細データ" meta="AUDIT TRAIL / RAW RESPONSE">
              <BattleDetailsSection
                response={view.displayedSuccess.response}
                logLevel={view.displayedSuccess.request.options.logLevel}
                {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
              />
            </Panel>
          </>
        ) : null}
      </div>

      {catalog.status === "ready" ? (
        <SelectionDialogs
          selectionDialog={selectionDialog}
          draft={effectiveDraft}
          mode="battle"
          catalog={catalog.response}
          unitImageMap={unitImageMap}
          memoryImageMap={memoryImageMap}
          violations={view.displayedViolations}
          dispatch={dispatch}
          playerEnhancementDispatch={playerEnhancement.dispatch}
          onClose={onCloseSelectionDialog}
        />
      ) : null}
    </>
  );
}
