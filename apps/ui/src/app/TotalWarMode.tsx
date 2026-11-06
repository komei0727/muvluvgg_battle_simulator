import { useCallback, useMemo, useReducer } from "react";
import { Panel } from "../components/Panel.js";
import type { CatalogLoadState } from "../features/catalog-selection/catalog-loader.js";
import {
  definitionImageMap,
  memoryImageMap,
  unitImageMap,
} from "../features/catalog-selection/definition-image-map.js";
import { selectCanSubmit } from "../features/formation/draft-validation.js";
import { withPlayerEnhancement } from "../features/formation/effective-draft.js";
import { BattleSetupLayout } from "../features/formation/BattleSetupLayout.js";
import { ExecutionParameterForm } from "../features/formation/ExecutionParameterForm.js";
import { FormationEditor } from "../features/formation/FormationEditor.js";
import { FormationResetControls } from "../features/formation/FormationResetControls.js";
import type { SelectionDialogState } from "../features/formation/formation-reducer.js";
import type { PlayerEnhancementPersistence } from "../features/formation/use-player-enhancement-persistence.js";
import type { UseFormationStatPreviewOptions } from "../features/formation/use-formation-stat-preview.js";
import { useFormationStatPreview } from "../features/formation/use-formation-stat-preview.js";
import { StatPreviewModeToggle } from "../features/formation/StatPreviewModeToggle.js";
import { SubmitControls } from "../features/formation/SubmitControls.js";
import {
  canOpenUnitEnhancementDialog,
  enhancementForSide,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import type { UnitSlotBadge } from "../features/formation/UnitSlot.js";
import { ValidationSummary } from "../features/formation/ValidationSummary.js";
import {
  selectDisplayedSuccess,
  selectIsCatalogRevisionMismatch,
  selectIsResultDirty,
} from "../features/simulation/execution-reducer.js";
import { SubmissionFeedback } from "../features/simulation/SubmissionFeedback.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import { useSimulationExecution } from "../features/simulation/use-simulation-execution.js";
import { FormationTabs } from "../features/total-war/FormationTabs.js";
import { reappearanceSlotId, selectReappearanceSlots } from "../features/total-war/reappearance.js";
import { usedFormationIndices } from "../features/total-war/total-war-draft.js";
import type { TotalWarDraft } from "../features/total-war/total-war-draft.js";
import { validateTotalWarDraft } from "../features/total-war/total-war-draft-validation.js";
import { totalWarReducer } from "../features/total-war/total-war-reducer.js";
import { buildTotalWarRequest } from "../features/total-war/total-war-request-mapper.js";
import type { TotalWarFormationSlotMaps } from "../features/total-war/total-war-request-mapper.js";
import {
  composeDisplayedDraft,
  formationHasErrors,
  labelTotalWarViolations,
  violationsForFormation,
} from "../features/total-war/total-war-view.js";
import type { ActiveFormations } from "../features/total-war/total-war-view.js";
import { mapTotalWarServerViolations } from "../features/total-war/total-war-violation-mapper.js";
import {
  createPersistedTotalWarState,
  useTotalWarPersistence,
} from "../features/total-war/use-total-war-persistence.js";
import { TOTAL_WAR_TURN_LIMIT } from "../entities/total-war.js";
import type { BattleDraft, Side } from "../entities/battle-draft.js";
import type { UiViolation } from "../entities/violation.js";
import { simulateTotalWar } from "../shared/api/api-client.js";
import type {
  BattleSimulationCatalogResponse,
  TotalWarRequest,
  TotalWarResponse,
  TotalWarResultResponse,
} from "../shared/api/api-contract.js";

import { SelectionDialogs } from "./SelectionDialogs.js";

const TOTAL_WAR_ENDPOINT = "POST /api/v1/total-war-simulations";

const REAPPEARANCE_BADGE: UnitSlotBadge = {
  label: "再登場 −99%",
  // プレビューAPIは1編成ずつしか受け取らず、再登場の補正を計算できない。
  previewNote: "再登場による −99% 補正は含みません",
};

export interface TotalWarModeProps {
  /** REF-059: `NormalBattleMode`と同じ理由でアンマウントしない（`NormalBattleMode.tsx`参照）。 */
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
  readonly simulateTotalWarImpl?: UseSimulationExecutionOptions<
    TotalWarRequest,
    TotalWarResponse
  >["simulateImpl"];
  readonly previewFormationStatsImpl?: UseFormationStatPreviewOptions["previewImpl"];
}

const NO_VIOLATIONS: readonly UiViolation[] = [];

function validateWhenReady(
  draft: TotalWarDraft,
  catalog: CatalogLoadState,
): readonly UiViolation[] {
  return catalog.status === "ready"
    ? validateTotalWarDraft(draft, catalog.response)
    : NO_VIOLATIONS;
}

function describeTotalWarResult(result: TotalWarResultResponse): string {
  return `${result.outcome} / ${result.completionReason} (turn ${String(result.completedTurn)} / ${String(TOTAL_WAR_TURN_LIMIT)})`;
}

/** 表示中の編成の枠のうち、再登場（R-TWR-02 #1）に当たる枠へバッジを付ける。 */
function reappearanceBadges(
  reappearing: ReadonlySet<string>,
  draft: BattleDraft,
  side: Side,
  active: ActiveFormations,
): ReadonlyMap<string, UnitSlotBadge> {
  return new Map(
    slotsForSide(draft, side)
      .filter((slot) => reappearing.has(reappearanceSlotId(active[side], slot.slotKey)))
      .map((slot) => [slot.slotKey, REAPPEARANCE_BADGE]),
  );
}

/**
 * 総力戦モード（UI-UC-007）。3組の編成draft（`totalWarReducer`）・実行state・
 * ステータスプレビューを自身のsliceとして持ち、他モードのdraftと実行stateに触れない
 * （UI-CMP-037）。編成エディタ・選択ダイアログには、陣営ごとの表示中の組を1編成ぶんの
 * draftとして渡し、総力戦を知らないまま再利用する（UI-CMP-039）。
 */
export function TotalWarMode({
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
  simulateTotalWarImpl,
  previewFormationStatsImpl,
}: TotalWarModeProps) {
  const [state, dispatch] = useReducer(totalWarReducer, undefined, createPersistedTotalWarState);
  const activeFormation = state.activeFormation;

  // 味方の陣営強化・ユニット強化は手持ちデータだけが持つ。3組それぞれへ重ねることで、
  // 同じユニットを置いた全編成の枠が同じ値を参照する（01_UI要求・画面設計.md §5.10）。
  const effectiveDraft = useMemo<TotalWarDraft>(() => {
    const [first, second, third] = state.draft.formations;
    return {
      ...state.draft,
      formations: [
        withPlayerEnhancement(first, playerEnhancement.state),
        withPlayerEnhancement(second, playerEnhancement.state),
        withPlayerEnhancement(third, playerEnhancement.state),
      ],
    };
  }, [state.draft, playerEnhancement.state]);

  const displayedDraft = useMemo(
    () => composeDisplayedDraft(effectiveDraft.formations, activeFormation),
    [effectiveDraft.formations, activeFormation],
  );

  const execution = useSimulationExecution<
    TotalWarRequest,
    TotalWarResponse,
    TotalWarFormationSlotMaps
  >(apiBaseUrl, { simulateImpl: simulateTotalWarImpl ?? simulateTotalWar });

  const violations = useMemo(
    () => validateWhenReady(effectiveDraft, catalog),
    [effectiveDraft, catalog],
  );
  const requestBuild = useMemo(() => buildTotalWarRequest(effectiveDraft), [effectiveDraft]);
  const serverViolations = useMemo(
    () =>
      execution.state.status === "failed" &&
      execution.state.error.violations !== undefined &&
      execution.state.slotContext !== undefined
        ? mapTotalWarServerViolations(execution.state.error.violations, execution.state.slotContext)
        : NO_VIOLATIONS,
    [execution.state],
  );
  const displayedViolations = useMemo(
    () => [...violations, ...serverViolations],
    [violations, serverViolations],
  );
  const reappearing = useMemo(() => selectReappearanceSlots(effectiveDraft), [effectiveDraft]);

  useTotalWarPersistence({ draft: state.draft, catalog, violations, dispatch });

  // UI-AC-027: プレビューは表示中の味方編成と表示中の敵編成の組み合わせで取る。編成
  // ボーナス・配置適性は自陣営の編成だけで決まるため、組み合わせる相手で値は変わらない。
  const statPreview = useFormationStatPreview(apiBaseUrl, displayedDraft, {
    mode: "NORMAL",
    enabled: active,
    ...(previewFormationStatsImpl !== undefined ? { previewImpl: previewFormationStatsImpl } : {}),
  });

  const isSubmitting = execution.state.status === "submitting";
  const formationDisabled = catalog.status !== "ready" || isSubmitting;
  const canSubmit = catalog.status === "ready" && requestBuild.ok && selectCanSubmit(violations);
  const displayedSuccess = selectDisplayedSuccess(execution.state);
  const isDirty = requestBuild.ok
    ? selectIsResultDirty(requestBuild.request, displayedSuccess?.request)
    : displayedSuccess !== undefined;
  const catalogRevisionMismatch = selectIsCatalogRevisionMismatch(
    displayedSuccess,
    catalog.status === "ready" ? catalog.response.catalogRevision : undefined,
  );

  const openSelection = useCallback(
    (selection: Exclude<SelectionDialogState, { kind: "closed" }>) => {
      if (
        selection.kind === "unitEnhancement" &&
        !canOpenUnitEnhancementDialog(displayedDraft, selection.slotKey)
      ) {
        return;
      }
      onRequestSelectionDialog(selection);
    },
    [displayedDraft, onRequestSelectionDialog],
  );

  const resetDraft = useCallback(() => {
    dispatch({ type: "draftReset" });
  }, []);

  const submit = () => {
    if (!requestBuild.ok) {
      return;
    }
    // 1編成ぶんの対応表は総力戦では使わない。422は編成ごとの表（`slotContext`）で逆引きする。
    execution.submit({
      request: requestBuild.request,
      allyUnitSlotKeys: [],
      enemyUnitSlotKeys: [],
      allyMemorySlotKeys: [],
      enemyMemorySlotKeys: [],
      allyGearSlotIndices: [],
      enemyGearSlotIndices: [],
      slotContext: requestBuild.formationSlotMaps,
    });
  };

  if (!active) {
    return null;
  }

  const sideViolations = (side: Side) =>
    violationsForFormation(displayedViolations, side, activeFormation[side]);
  // ダイアログはどちらの陣営の枠からも開くため、両陣営の表示中の編成の違反を渡す。
  // 編成を持たない違反は両方に含まれるので、片方からだけ取る。
  const dialogViolations = [
    ...sideViolations("ally"),
    ...sideViolations("enemy").filter((violation) => violation.formationIndex !== undefined),
  ];
  const unscopedViolations = displayedViolations.filter(
    (violation) => violation.formationIndex === undefined,
  );

  const renderSide = (side: Side, readyCatalog: BattleSimulationCatalogResponse) => (
    <div data-formation-side={side}>
      <FormationTabs
        side={side}
        count={effectiveDraft.formationCounts[side]}
        active={activeFormation[side]}
        formationsWithErrors={usedFormationIndices(effectiveDraft, side).filter((index) =>
          formationHasErrors(displayedViolations, side, index),
        )}
        disabled={formationDisabled}
        onActivate={(index) => {
          dispatch({ type: "formationActivated", side, index });
        }}
        onAdd={() => {
          dispatch({ type: "formationAdded", side });
        }}
        onRemove={() => {
          dispatch({ type: "formationRemoved", side });
        }}
      >
        {/* 移動元など編成グリッドのlocal stateは表示中の編成に属する。表示対象が変わったら
            作り直し、別の編成の枠へ移動が持ち越されないようにする。削除では表示中のindexが
            変わらないまま中身が入れ替わるため、編成数も鍵に含める。 */}
        <FormationEditor
          key={`${side}-${String(activeFormation[side])}-${String(effectiveDraft.formationCounts[side])}`}
          side={side}
          slots={slotsForSide(displayedDraft, side)}
          memoryDefinitionIds={memorySlotsForSide(displayedDraft, side)}
          catalog={readyCatalog}
          violations={sideViolations(side)}
          disabled={formationDisabled}
          imageMap={definitionImageMap}
          enhancement={enhancementForSide(displayedDraft, side)}
          statPreview={statPreview}
          showBaseStats={showBaseStats}
          slotBadges={reappearanceBadges(reappearing, displayedDraft, side, activeFormation)}
          onOpenUnitSelection={(slotKey) => {
            openSelection({ kind: "unit", slotKey });
          }}
          onOpenMemorySelection={(memorySide, index) => {
            openSelection({ kind: "memory", side: memorySide, index });
          }}
          onOpenUnitEnhancement={(slotKey) => {
            openSelection({ kind: "unitEnhancement", slotKey });
          }}
          onEnhancementToggle={(toggledSide, enabled) => {
            dispatch({ type: "enhancementToggled", side: toggledSide, enabled });
          }}
          onAcademyLevelChange={(changedSide, group, key, value) => {
            if (changedSide === "ally") {
              playerEnhancement.dispatch({ type: "academyLevelChanged", group, key, value });
              return;
            }
            dispatch({ type: "academyLevelChanged", side: changedSide, group, key, value });
          }}
          onLevelLinkToggle={(changedSide, enabled) => {
            if (changedSide === "ally") {
              playerEnhancement.dispatch({ type: "levelLinkToggled", enabled });
              return;
            }
            dispatch({ type: "levelLinkToggled", side: changedSide, enabled });
          }}
          onLevelLinkChange={(changedSide, value) => {
            if (changedSide === "ally") {
              playerEnhancement.dispatch({ type: "levelLinkLevelChanged", value });
              return;
            }
            dispatch({ type: "levelLinkLevelChanged", side: changedSide, value });
          }}
          onMoveUnit={(fromSlotKey, toSlotKey) => {
            dispatch({ type: "unitMoved", fromSlotKey, toSlotKey });
          }}
        />
      </FormationTabs>
    </div>
  );

  return (
    <>
      <div role="tabpanel" id="tabpanel-totalWar" aria-labelledby="tab-totalWar">
        <Panel step="01" title="総力戦パラメータ" meta="FORMATIONS / MEMORY / EXECUTION">
          {catalog.status === "loading" ? <p>Catalogを読込中…</p> : null}
          {/* 401はPageのアクセスキー入力欄が引き受けるため、ここでは出さない。 */}
          {catalog.status === "failed" && catalog.error.kind !== "UNAUTHORIZED" ? (
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
                ally={renderSide("ally", catalog.response)}
                enemy={renderSide("enemy", catalog.response)}
              />

              <ExecutionParameterForm
                turnLimit=""
                logLevel={effectiveDraft.logLevel}
                endpoint={TOTAL_WAR_ENDPOINT}
                disabled={formationDisabled}
                violations={unscopedViolations}
                fixedTurnLimit={TOTAL_WAR_TURN_LIMIT}
                onTurnLimitChange={() => undefined}
                onLogLevelChange={(value) => {
                  dispatch({ type: "logLevelChanged", value });
                }}
              />

              <ValidationSummary violations={labelTotalWarViolations(violations)} />

              <SubmitControls
                canSubmit={canSubmit}
                isSubmitting={isSubmitting}
                submitLabel="総力戦を開始"
                onSubmit={submit}
                onCancel={execution.cancel}
              />

              <FormationResetControls
                disabled={formationDisabled}
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
          isDirty={isDirty}
          successMessage="総力戦が完了しました。"
          resultSummary={
            displayedSuccess === undefined
              ? ""
              : describeTotalWarResult(displayedSuccess.response.result)
          }
          catalogRevisionMismatch={catalogRevisionMismatch}
          onReloadCatalog={onReloadCatalog}
        />
      </div>

      {catalog.status === "ready" ? (
        <SelectionDialogs
          selectionDialog={selectionDialog}
          draft={displayedDraft}
          mode="totalWar"
          catalog={catalog.response}
          unitImageMap={unitImageMap}
          memoryImageMap={memoryImageMap}
          violations={dialogViolations}
          dispatch={dispatch}
          playerEnhancementDispatch={playerEnhancement.dispatch}
          onClose={onCloseSelectionDialog}
        />
      ) : null}
    </>
  );
}
