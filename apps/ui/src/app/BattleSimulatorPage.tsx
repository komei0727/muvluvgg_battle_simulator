import { useMemo, useReducer } from "react";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { MemorySelectionDialog } from "../features/catalog-selection/MemorySelectionDialog.js";
import { UnitSelectionDialog } from "../features/catalog-selection/UnitSelectionDialog.js";
import { BattleDetailsSection } from "../features/details/BattleDetailsSection.js";
import { BattleSetupLayout } from "../features/formation/BattleSetupLayout.js";
import { selectCanSubmit, validateDraft } from "../features/formation/draft-validation.js";
import { ExecutionParameterForm } from "../features/formation/ExecutionParameterForm.js";
import { FormationEditor } from "../features/formation/FormationEditor.js";
import {
  createInitialFormationState,
  formationReducer,
  MAX_UNITS_PER_SIDE,
} from "../features/formation/formation-reducer.js";
import { buildBattleSimulationRequest } from "../features/formation/request-mapper.js";
import { SubmitControls } from "../features/formation/SubmitControls.js";
import { memorySlotsForSide, slotsForSide } from "../features/formation/types.js";
import { ValidationSummary } from "../features/formation/ValidationSummary.js";
import type { UseCatalogLoaderOptions } from "../features/catalog-selection/catalog-loader.js";
import { useCatalogLoader } from "../features/catalog-selection/catalog-loader.js";
import {
  selectDisplayedSuccess,
  selectIsCatalogRevisionMismatch,
  selectIsResultDirty,
} from "../features/simulation/execution-reducer.js";
import { SubmissionFeedback } from "../features/simulation/SubmissionFeedback.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import { useSimulationExecution } from "../features/simulation/use-simulation-execution.js";
import { mapServerViolationsToUiViolations } from "../features/simulation/violation-mapper.js";
import { BattleSummarySection } from "../features/summary/BattleSummarySection.js";

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

  const violations = useMemo(
    () => (catalog.status === "ready" ? validateDraft(state.draft, catalog.response) : []),
    [catalog, state.draft],
  );
  const requestBuild = useMemo(() => buildBattleSimulationRequest(state.draft), [state.draft]);
  const isSubmitting = execution.state.status === "submitting";
  const canSubmit = catalog.status === "ready" && requestBuild.ok && selectCanSubmit(violations);

  const displayedSuccess = selectDisplayedSuccess(execution.state);
  const isDirty = requestBuild.ok
    ? selectIsResultDirty(requestBuild.request, displayedSuccess?.request)
    : displayedSuccess !== undefined;
  const catalogRevisionMismatch = selectIsCatalogRevisionMismatch(
    displayedSuccess,
    catalog.status === "ready" ? catalog.response.catalogRevision : undefined,
  );

  const serverViolations =
    execution.state.status === "failed" && execution.state.error.violations !== undefined
      ? mapServerViolationsToUiViolations(
          execution.state.error.violations,
          execution.state.allyUnitSlotKeys,
          execution.state.enemyUnitSlotKeys,
          execution.state.allyMemorySlotKeys,
          execution.state.enemyMemorySlotKeys,
        )
      : [];
  const displayedViolations = [...violations, ...serverViolations];

  const formationDisabled = catalog.status !== "ready" || isSubmitting;

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
                  disabled={formationDisabled}
                  onOpenUnitSelection={(slotKey) => {
                    dispatch({ type: "selectionOpened", selection: { kind: "unit", slotKey } });
                  }}
                  onOpenMemorySelection={(side, index) => {
                    dispatch({
                      type: "selectionOpened",
                      selection: { kind: "memory", side, index },
                    });
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
                  disabled={formationDisabled}
                  onOpenUnitSelection={(slotKey) => {
                    dispatch({ type: "selectionOpened", selection: { kind: "unit", slotKey } });
                  }}
                  onOpenMemorySelection={(side, index) => {
                    dispatch({
                      type: "selectionOpened",
                      selection: { kind: "memory", side, index },
                    });
                  }}
                />
              }
            />

            <ExecutionParameterForm
              turnLimit={state.draft.turnLimit}
              logLevel={state.draft.logLevel}
              endpoint={SIMULATION_ENDPOINT}
              disabled={formationDisabled}
              violations={displayedViolations}
              onTurnLimitChange={(value) => {
                dispatch({ type: "turnLimitChanged", value });
              }}
              onLogLevelChange={(value) => {
                dispatch({ type: "logLevelChanged", value });
              }}
            />

            <ValidationSummary violations={violations} />

            <SubmitControls
              canSubmit={canSubmit}
              isSubmitting={isSubmitting}
              onSubmit={() => {
                if (requestBuild.ok) {
                  execution.submit({
                    request: requestBuild.request,
                    allyUnitSlotKeys: requestBuild.allyUnitSlotKeys,
                    enemyUnitSlotKeys: requestBuild.enemyUnitSlotKeys,
                    allyMemorySlotKeys: requestBuild.allyMemorySlotKeys,
                    enemyMemorySlotKeys: requestBuild.enemyMemorySlotKeys,
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
        isDirty={isDirty}
        catalogRevisionMismatch={catalogRevisionMismatch}
        onReloadCatalog={catalogLoader.reload}
      />

      {displayedSuccess !== undefined && !catalogRevisionMismatch ? (
        <>
          <Panel step="02" title="戦闘サマリ" meta="OUTCOME / ROSTER">
            <BattleSummarySection
              response={displayedSuccess.response}
              {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
              turnLimit={displayedSuccess.request.turnLimit}
            />
          </Panel>
          <Panel step="03" title="戦闘詳細データ" meta="AUDIT TRAIL / RAW RESPONSE">
            <BattleDetailsSection
              response={displayedSuccess.response}
              {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
            />
          </Panel>
        </>
      ) : null}

      {catalog.status === "ready" && state.selectionDialog.kind === "unit"
        ? (() => {
            const slotKey = state.selectionDialog.slotKey;
            const slot = [...state.draft.allySlots, ...state.draft.enemySlots].find(
              (s) => s.slotKey === slotKey,
            );
            if (slot === undefined) {
              return null;
            }
            const atCapacity =
              slotsForSide(state.draft, slot.side).filter((s) => s.unitDefinitionId !== undefined)
                .length >= MAX_UNITS_PER_SIDE;
            return (
              <UnitSelectionDialog
                units={catalog.response.units}
                {...(slot.unitDefinitionId !== undefined
                  ? { currentUnitDefinitionId: slot.unitDefinitionId }
                  : {})}
                atCapacity={atCapacity}
                onSelect={(unitDefinitionId) => {
                  dispatch({ type: "unitSelected", slotKey, unitDefinitionId });
                }}
                onRemove={() => {
                  dispatch({ type: "unitRemoved", slotKey });
                }}
                onClose={() => {
                  dispatch({ type: "selectionClosed" });
                }}
              />
            );
          })()
        : null}

      {catalog.status === "ready" && state.selectionDialog.kind === "memory"
        ? (() => {
            const { side, index } = state.selectionDialog;
            const currentMemoryDefinitionId = memorySlotsForSide(state.draft, side)[index];
            return (
              <MemorySelectionDialog
                memories={catalog.response.memories}
                {...(currentMemoryDefinitionId !== undefined ? { currentMemoryDefinitionId } : {})}
                onSelect={(memoryDefinitionId) => {
                  dispatch({ type: "memorySelected", side, index, memoryDefinitionId });
                }}
                onRemove={() => {
                  dispatch({ type: "memoryRemoved", side, index });
                }}
                onClose={() => {
                  dispatch({ type: "selectionClosed" });
                }}
              />
            );
          })()
        : null}
    </AppShell>
  );
}
