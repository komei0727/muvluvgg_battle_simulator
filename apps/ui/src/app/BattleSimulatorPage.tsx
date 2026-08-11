import { useReducer } from "react";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { BattleDetailsSection } from "../features/details/BattleDetailsSection.js";
import { BattleSetupLayout } from "../features/formation/BattleSetupLayout.js";
import { ExecutionParameterForm } from "../features/formation/ExecutionParameterForm.js";
import { FormationEditor } from "../features/formation/FormationEditor.js";
import {
  createInitialFormationState,
  formationReducer,
} from "../features/formation/formation-reducer.js";
import { SubmitControls } from "../features/formation/SubmitControls.js";
import {
  enhancementForSide,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import { ValidationSummary } from "../features/formation/ValidationSummary.js";
import type { UseCatalogLoaderOptions } from "../features/catalog-selection/catalog-loader.js";
import { useCatalogLoader } from "../features/catalog-selection/catalog-loader.js";
import {
  definitionImageMap,
  memoryImageMap,
  unitImageMap,
} from "../features/catalog-selection/definition-image-map.js";
import { SubmissionFeedback } from "../features/simulation/SubmissionFeedback.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import { useSimulationExecution } from "../features/simulation/use-simulation-execution.js";
import { BattleSummarySection } from "../features/summary/BattleSummarySection.js";
import { SelectionDialogs } from "./SelectionDialogs.js";
import { useBattleSimulatorViewModel } from "./use-battle-simulator-view-model.js";

export interface BattleSimulatorPageProps {
  readonly apiBaseUrl: string;
  readonly buildRevision?: string;
  readonly getCatalogImpl?: UseCatalogLoaderOptions["getCatalogImpl"];
  readonly simulateImpl?: UseSimulationExecutionOptions["simulateImpl"];
}

const SIMULATION_ENDPOINT = "POST /api/v1/battle-simulations";

export function BattleSimulatorPage({
  apiBaseUrl,
  buildRevision,
  getCatalogImpl,
  simulateImpl,
}: BattleSimulatorPageProps) {
  const catalogLoader = useCatalogLoader(
    apiBaseUrl,
    getCatalogImpl !== undefined ? { getCatalogImpl } : {},
  );
  const [state, dispatch] = useReducer(formationReducer, undefined, createInitialFormationState);
  const catalog = catalogLoader.state;
  const execution = useSimulationExecution(
    apiBaseUrl,
    simulateImpl !== undefined ? { simulateImpl } : {},
  );

  const view = useBattleSimulatorViewModel({
    catalog,
    draft: state.draft,
    execution: execution.state,
  });
  const { displayedSuccess, displayedViolations, requestBuild } = view;

  return (
    <AppShell {...(buildRevision !== undefined ? { buildRevision } : {})}>
      <Panel step="01" title="戦闘パラメータ" meta="FORMATION / MEMORY / EXECUTION">
        {catalog.status === "loading" ? <p>Catalogを読込中…</p> : null}
        {catalog.status === "failed" ? (
          <div role="alert">
            <p>{catalog.error.message}</p>
            <button type="button" onClick={catalogLoader.reload}>
              再読込
            </button>
          </div>
        ) : null}

        {catalog.status === "ready" ? (
          <>
            <BattleSetupLayout
              ally={
                <FormationEditor
                  side="ally"
                  slots={slotsForSide(state.draft, "ally")}
                  memoryDefinitionIds={memorySlotsForSide(state.draft, "ally")}
                  catalog={catalog.response}
                  violations={displayedViolations}
                  disabled={view.formationDisabled}
                  imageMap={definitionImageMap}
                  enhancement={enhancementForSide(state.draft, "ally")}
                  onOpenUnitSelection={(slotKey) => {
                    dispatch({ type: "selectionOpened", selection: { kind: "unit", slotKey } });
                  }}
                  onOpenMemorySelection={(side, index) => {
                    dispatch({
                      type: "selectionOpened",
                      selection: { kind: "memory", side, index },
                    });
                  }}
                  onOpenUnitEnhancement={(slotKey) => {
                    dispatch({
                      type: "selectionOpened",
                      selection: { kind: "unitEnhancement", slotKey },
                    });
                  }}
                  onEnhancementToggle={(side, enabled) => {
                    dispatch({ type: "enhancementToggled", side, enabled });
                  }}
                  onAcademyLevelChange={(side, group, key, value) => {
                    dispatch({ type: "academyLevelChanged", side, group, key, value });
                  }}
                />
              }
              enemy={
                <FormationEditor
                  side="enemy"
                  slots={slotsForSide(state.draft, "enemy")}
                  memoryDefinitionIds={memorySlotsForSide(state.draft, "enemy")}
                  catalog={catalog.response}
                  violations={displayedViolations}
                  disabled={view.formationDisabled}
                  imageMap={definitionImageMap}
                  enhancement={enhancementForSide(state.draft, "enemy")}
                  onOpenUnitSelection={(slotKey) => {
                    dispatch({ type: "selectionOpened", selection: { kind: "unit", slotKey } });
                  }}
                  onOpenMemorySelection={(side, index) => {
                    dispatch({
                      type: "selectionOpened",
                      selection: { kind: "memory", side, index },
                    });
                  }}
                  onOpenUnitEnhancement={(slotKey) => {
                    dispatch({
                      type: "selectionOpened",
                      selection: { kind: "unitEnhancement", slotKey },
                    });
                  }}
                  onEnhancementToggle={(side, enabled) => {
                    dispatch({ type: "enhancementToggled", side, enabled });
                  }}
                  onAcademyLevelChange={(side, group, key, value) => {
                    dispatch({ type: "academyLevelChanged", side, group, key, value });
                  }}
                />
              }
            />

            <ExecutionParameterForm
              turnLimit={state.draft.turnLimit}
              logLevel={state.draft.logLevel}
              endpoint={SIMULATION_ENDPOINT}
              disabled={view.formationDisabled}
              violations={displayedViolations}
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
              onSubmit={() => {
                if (requestBuild.ok) {
                  execution.submit({
                    request: requestBuild.request,
                    allyUnitSlotKeys: requestBuild.allyUnitSlotKeys,
                    enemyUnitSlotKeys: requestBuild.enemyUnitSlotKeys,
                    allyMemorySlotKeys: requestBuild.allyMemorySlotKeys,
                    enemyMemorySlotKeys: requestBuild.enemyMemorySlotKeys,
                    allyGearSlotIndices: requestBuild.allyGearSlotIndices,
                    enemyGearSlotIndices: requestBuild.enemyGearSlotIndices,
                  });
                }
              }}
              onCancel={execution.cancel}
            />
          </>
        ) : null}
      </Panel>

      <SubmissionFeedback
        state={execution.state}
        isDirty={view.isDirty}
        catalogRevisionMismatch={view.catalogRevisionMismatch}
        onReloadCatalog={catalogLoader.reload}
      />

      {displayedSuccess !== undefined && !view.catalogRevisionMismatch ? (
        <>
          <Panel step="02" title="戦闘サマリ" meta="OUTCOME / ROSTER">
            <BattleSummarySection
              response={displayedSuccess.response}
              {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
              turnLimit={displayedSuccess.request.turnLimit}
              imageMap={unitImageMap}
            />
          </Panel>
          <Panel step="03" title="戦闘詳細データ" meta="AUDIT TRAIL / RAW RESPONSE">
            <BattleDetailsSection
              response={displayedSuccess.response}
              logLevel={displayedSuccess.request.options.logLevel}
              {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
            />
          </Panel>
        </>
      ) : null}

      {catalog.status === "ready" ? (
        <SelectionDialogs
          selectionDialog={state.selectionDialog}
          draft={state.draft}
          catalog={catalog.response}
          unitImageMap={unitImageMap}
          memoryImageMap={memoryImageMap}
          violations={displayedViolations}
          dispatch={dispatch}
        />
      ) : null}
    </AppShell>
  );
}
