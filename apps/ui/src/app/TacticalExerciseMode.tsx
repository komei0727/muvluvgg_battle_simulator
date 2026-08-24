import { useCallback, useMemo, useReducer } from "react";
import { Panel } from "../components/Panel.js";
import { BattleDetailsSection } from "../features/details/BattleDetailsSection.js";
import type { CatalogLoadState } from "../features/catalog-selection/catalog-loader.js";
import {
  definitionImageMap,
  memoryImageMap,
  unitImageMap,
} from "../features/catalog-selection/definition-image-map.js";
import { EXERCISE_TURN_LIMIT } from "../entities/tactical-exercise.js";
import { BreakTimeline } from "../features/exercise/BreakTimeline.js";
import { ExerciseEnemyFormation } from "../features/exercise/ExerciseEnemyFormation.js";
import { validateExerciseDraft } from "../features/exercise/exercise-draft-validation.js";
import { buildTacticalExerciseRequest } from "../features/exercise/exercise-request-mapper.js";
import {
  describeExerciseResult,
  selectExerciseResultView,
} from "../features/exercise/exercise-result-projector.js";
import { mapEvaluationViolationsToUiViolations } from "../features/exercise/evaluation-violation-mapper.js";
import { StatisticsRunFeedback } from "../features/exercise/StatisticsRunFeedback.js";
import {
  buildTacticalExerciseEvaluationRequest,
  evaluationFormationSignature,
} from "../features/exercise/exercise-request-mapper.js";
import { useExerciseStatisticsRun } from "../features/exercise/use-exercise-statistics-run.js";
import type { UseExerciseStatisticsRunOptions } from "../features/exercise/use-exercise-statistics-run.js";
import { ScoreSummaryHeader } from "../features/exercise/ScoreSummaryHeader.js";
import { ExerciseStatisticsSummary } from "../features/exercise-stats/ExerciseStatisticsSummary.js";
import { UnitStatisticsSection } from "../features/exercise-stats/UnitStatisticsSection.js";
import {
  buildScoreStatisticsReport,
  resolveAllyUnitLabels,
} from "../features/exercise-stats/statistics-report.js";
import { BattleSetupLayout } from "../features/formation/BattleSetupLayout.js";
import { ExecutionParameterForm } from "../features/formation/ExecutionParameterForm.js";
import type { ExerciseExecutionFormProps } from "../features/formation/ExecutionParameterForm.js";
import { FormationEditor } from "../features/formation/FormationEditor.js";
import { FormationResetControls } from "../features/formation/FormationResetControls.js";
import { formationReducer } from "../features/formation/formation-reducer.js";
import type { SelectionDialogState } from "../features/formation/formation-reducer.js";
import { withPlayerEnhancement } from "../features/formation/effective-draft.js";
import { EXERCISE_DRAFT_STORAGE_KEY } from "../features/formation/persistence.js";
import {
  createPersistedInitialState,
  usePersistedDraft,
} from "../features/formation/use-formation-persistence.js";
import type { PlayerEnhancementPersistence } from "../features/formation/use-player-enhancement-persistence.js";
import { SubmitControls } from "../features/formation/SubmitControls.js";
import type { UseFormationStatPreviewOptions } from "../features/formation/use-formation-stat-preview.js";
import { useFormationStatPreview } from "../features/formation/use-formation-stat-preview.js";
import { StatPreviewModeToggle } from "../features/formation/StatPreviewModeToggle.js";
import {
  canOpenUnitEnhancementDialog,
  enhancementForSide,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import { ValidationSummary } from "../features/formation/ValidationSummary.js";
import type {
  BattleSimulationCatalogResponse,
  TacticalExerciseRequest,
  TacticalExerciseResponse,
} from "../shared/api/api-contract.js";
import { simulateTacticalExercise } from "../shared/api/api-client.js";
import { SubmissionFeedback } from "../features/simulation/SubmissionFeedback.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import { useSimulationExecution } from "../features/simulation/use-simulation-execution.js";
import { BattleSummarySection } from "../features/summary/BattleSummarySection.js";

import { SelectionDialogs } from "./SelectionDialogs.js";
import { useBattleSimulatorViewModel } from "./use-battle-simulator-view-model.js";

const EXERCISE_ENDPOINT = "POST /api/v1/tactical-exercises";

export interface TacticalExerciseModeProps {
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
  readonly simulateTacticalExerciseImpl?: UseSimulationExecutionOptions<
    TacticalExerciseRequest,
    TacticalExerciseResponse
  >["simulateImpl"];
  readonly previewFormationStatsImpl?: UseFormationStatPreviewOptions["previewImpl"];
  readonly evaluateTacticalExerciseImpl?: UseExerciseStatisticsRunOptions["evaluateImpl"];
}

/**
 * 戦術演習モード。編成draft・単一実行・統計実行を自身のsliceとして持つ
 * （REF-059 / Issue #604）。味方の学園レベル・レベルリンク・ユニット強化と
 * ダイアログ選択状態はモードに依らないため`BattleSimulatorPage`から受け取る。
 */
export function TacticalExerciseMode({
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
  simulateTacticalExerciseImpl,
  previewFormationStatsImpl,
  evaluateTacticalExerciseImpl,
}: TacticalExerciseModeProps) {
  const [exerciseState, dispatch] = useReducer(
    formationReducer,
    EXERCISE_DRAFT_STORAGE_KEY,
    createPersistedInitialState,
  );
  const effectiveDraft = useMemo(
    () => withPlayerEnhancement(exerciseState.draft, playerEnhancement.state),
    [exerciseState.draft, playerEnhancement.state],
  );

  const execution = useSimulationExecution<TacticalExerciseRequest, TacticalExerciseResponse>(
    apiBaseUrl,
    { simulateImpl: simulateTacticalExerciseImpl ?? simulateTacticalExercise },
  );
  const statisticsRun = useExerciseStatisticsRun(
    apiBaseUrl,
    evaluateTacticalExerciseImpl !== undefined
      ? { evaluateImpl: evaluateTacticalExerciseImpl }
      : {},
  );

  const view = useBattleSimulatorViewModel({
    catalog,
    draft: effectiveDraft,
    execution: execution.state,
    validate: validateExerciseDraft,
    buildRequest: buildTacticalExerciseRequest,
  });

  usePersistedDraft({
    storageKey: EXERCISE_DRAFT_STORAGE_KEY,
    draft: exerciseState.draft,
    catalog,
    violations: view.violations,
    dispatch,
  });

  // UI-AC-027: 非活性モードは裏で編成状態プレビューを取得し続けない（`enabled: active`）。
  const statPreview = useFormationStatPreview(apiBaseUrl, effectiveDraft, {
    mode: "TACTICAL_EXERCISE",
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

  // UI-AC-041: 演習の実行指定。ログレベル選択の置き換え。
  const exerciseExecutionForm: ExerciseExecutionFormProps = {
    value: exerciseState.draft.exerciseExecution,
    onModeChange: (value) => {
      dispatch({ type: "exerciseExecutionModeChanged", value });
    },
    onRunCountChange: (value) => {
      dispatch({ type: "exerciseRunCountChanged", value });
    },
    onSeedChange: (value) => {
      dispatch({ type: "exerciseSeedChanged", value });
    },
  };

  const { mode: exerciseExecutionMode, runCount, seed } = exerciseState.draft.exerciseExecution;
  const isStatisticsRun = exerciseExecutionMode === "STATISTICS";
  // 実行中のロックは演習タブに閉じる。進捗も中断ボタンも演習タブにしか無いため、
  // 通常戦闘まで無効化すると止める手段が無いまま実行の終わりを待たせることになる。
  const isStatisticsRunning = isStatisticsRun && statisticsRun.state.status === "running";

  const statisticsViolations =
    isStatisticsRun &&
    statisticsRun.state.status === "failed" &&
    statisticsRun.state.error.kind === "API" &&
    statisticsRun.state.error.error.violations !== undefined
      ? mapEvaluationViolationsToUiViolations(
          statisticsRun.state.error.error.violations,
          statisticsRun.state.submission,
        )
      : [];

  const currentEvaluationBuild = isStatisticsRun
    ? buildTacticalExerciseEvaluationRequest(effectiveDraft, {
        runsPerCandidate: 1,
        seed: "-",
      })
    : { ok: false as const };
  const statisticsAggregate =
    statisticsRun.state.status === "succeeded" || statisticsRun.state.status === "cancelled"
      ? statisticsRun.state.aggregate
      : undefined;
  const statisticsResultDirty =
    statisticsAggregate !== undefined &&
    currentEvaluationBuild.ok &&
    evaluationFormationSignature(currentEvaluationBuild.request) !==
      (statisticsRun.state.status === "succeeded" || statisticsRun.state.status === "cancelled"
        ? statisticsRun.state.submission.formationSignature
        : "");
  const displayedViolations = [...view.displayedViolations, ...statisticsViolations];
  const statisticsCatalogRevisionMismatch =
    statisticsAggregate !== undefined &&
    (catalog.status !== "ready" ||
      statisticsAggregate.catalogRevision !== catalog.response.catalogRevision);
  // 走っているチャンクは実行開始時のdraftで送られ続けるため、実行中の編集を許すと
  // 画面と結果が食い違う。単一実行（`formationDisabled`）と同じ扱いにする。
  const formationDisabled = view.formationDisabled || isStatisticsRunning;

  const completedStatisticsRun =
    statisticsRun.state.status === "succeeded" || statisticsRun.state.status === "cancelled"
      ? statisticsRun.state
      : undefined;
  const readyCatalogResponse = catalog.status === "ready" ? catalog.response : undefined;
  const statisticsDisplay = useMemo(
    () =>
      completedStatisticsRun === undefined || statisticsCatalogRevisionMismatch
        ? undefined
        : {
            aggregate: completedStatisticsRun.aggregate,
            score: buildScoreStatisticsReport(completedStatisticsRun.aggregate, {
              seed: completedStatisticsRun.seed,
              requestedRuns: completedStatisticsRun.progress.requestedRuns,
            }),
            labels: resolveAllyUnitLabels(
              completedStatisticsRun.submission.allyUnitDefinitionIds,
              readyCatalogResponse,
            ),
          },
    [completedStatisticsRun, statisticsCatalogRevisionMismatch, readyCatalogResponse],
  );

  const submit = () => {
    if (isStatisticsRun) {
      // 実行回数の値域は送信前検証が押さえている（`exercise-draft-validation.ts`）ため、
      // ここへ来る時点で整数である。
      if (runCount !== "") {
        statisticsRun.start({ draft: effectiveDraft, runCount, seed });
      }
      return;
    }
    if (view.requestBuild.ok) {
      const { ok: _ok, ...input } = view.requestBuild;
      execution.submit(input);
    }
  };

  if (!active) {
    return null;
  }

  const renderAllyEditor = (readyCatalog: BattleSimulationCatalogResponse) => (
    <FormationEditor
      side="ally"
      slots={slotsForSide(effectiveDraft, "ally")}
      memoryDefinitionIds={memorySlotsForSide(effectiveDraft, "ally")}
      catalog={readyCatalog}
      violations={displayedViolations}
      disabled={formationDisabled}
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
        playerEnhancement.dispatch({ type: "academyLevelChanged", group, key, value });
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
  );

  return (
    <>
      <div role="tabpanel" id="tabpanel-exercise" aria-labelledby="tab-exercise">
        <Panel step="01" title="演習パラメータ" meta="FORMATION / MEMORY / EXERCISE">
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
                ally={renderAllyEditor(catalog.response)}
                enemy={
                  <ExerciseEnemyFormation
                    slots={slotsForSide(effectiveDraft, "enemy")}
                    catalog={catalog.response}
                    violations={displayedViolations}
                    disabled={formationDisabled}
                    imageMap={definitionImageMap}
                    statPreview={statPreview}
                    showBaseStats={showBaseStats}
                    onOpenUnitSelection={(slotKey) => {
                      openSelection({ kind: "unit", slotKey });
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
                endpoint={EXERCISE_ENDPOINT}
                disabled={formationDisabled}
                violations={displayedViolations}
                fixedTurnLimit={EXERCISE_TURN_LIMIT}
                exerciseExecution={exerciseExecutionForm}
                onTurnLimitChange={(value) => {
                  dispatch({ type: "turnLimitChanged", value });
                }}
                onLogLevelChange={(value) => {
                  dispatch({ type: "logLevelChanged", value });
                }}
              />

              <ValidationSummary violations={view.violations} />

              <SubmitControls
                canSubmit={view.canSubmit && !isStatisticsRunning}
                isSubmitting={view.isSubmitting || isStatisticsRunning}
                submitLabel="戦術演習を開始"
                onSubmit={submit}
                onCancel={isStatisticsRun ? statisticsRun.cancel : execution.cancel}
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

        {isStatisticsRun ? (
          <StatisticsRunFeedback
            state={statisticsRun.state}
            onCancel={statisticsRun.cancel}
            isDirty={statisticsResultDirty}
            catalogRevisionMismatch={statisticsCatalogRevisionMismatch}
            onReloadCatalog={onReloadCatalog}
          />
        ) : null}

        {!isStatisticsRun ? (
          <SubmissionFeedback
            state={execution.state}
            isDirty={view.isDirty}
            successMessage="戦術演習が完了しました。"
            resultSummary={
              view.displayedSuccess === undefined
                ? ""
                : describeExerciseResult(view.displayedSuccess.response.result)
            }
            catalogRevisionMismatch={view.catalogRevisionMismatch}
            onReloadCatalog={onReloadCatalog}
          />
        ) : null}

        {isStatisticsRun && statisticsDisplay !== undefined ? (
          <>
            <Panel step="02" title="演習統計サマリ" meta="SCORE / DAILY BEST / DISTRIBUTION">
              <ExerciseStatisticsSummary report={statisticsDisplay.score} />
            </Panel>
            <Panel step="03" title="キャラ別統計" meta="DAMAGE / BREAK / EXPORT">
              <UnitStatisticsSection
                aggregate={statisticsDisplay.aggregate}
                labels={statisticsDisplay.labels}
                score={statisticsDisplay.score}
              />
            </Panel>
          </>
        ) : null}

        {view.displayedSuccess !== undefined &&
        !isStatisticsRun &&
        !view.catalogRevisionMismatch ? (
          <>
            <Panel step="02" title="演習サマリ" meta="SCORE / BREAK / ROSTER">
              <BattleSummarySection
                response={view.displayedSuccess.response}
                {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
                header={
                  <>
                    <ScoreSummaryHeader
                      result={view.displayedSuccess.response.result}
                      battleId={view.displayedSuccess.response.battleId}
                      catalogRevision={view.displayedSuccess.response.catalogRevision}
                    />
                    <BreakTimeline
                      breaks={
                        selectExerciseResultView(
                          view.displayedSuccess.response.result,
                          catalog.status === "ready" ? catalog.response : undefined,
                        ).breaks
                      }
                    />
                  </>
                }
                imageMap={unitImageMap}
              />
            </Panel>
            <Panel step="03" title="演習詳細データ" meta="AUDIT TRAIL / RAW RESPONSE">
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
          mode="exercise"
          catalog={catalog.response}
          unitImageMap={unitImageMap}
          memoryImageMap={memoryImageMap}
          violations={displayedViolations}
          dispatch={dispatch}
          playerEnhancementDispatch={playerEnhancement.dispatch}
          onClose={onCloseSelectionDialog}
        />
      ) : null}
    </>
  );
}
