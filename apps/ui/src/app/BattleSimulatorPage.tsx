import { useCallback, useReducer, useState } from "react";
import { AppShell } from "../components/AppShell.js";
import { Panel } from "../components/Panel.js";
import { BattleDetailsSection } from "../features/details/BattleDetailsSection.js";
import { BreakTimeline } from "../features/exercise/BreakTimeline.js";
import { ExerciseEnemySlot } from "../features/exercise/ExerciseEnemySlot.js";
import { EXERCISE_TURN_LIMIT } from "../features/exercise/exercise-draft-validation.js";
import { validateExerciseDraft } from "../features/exercise/exercise-draft-validation.js";
import { buildTacticalExerciseRequest } from "../features/exercise/exercise-request-mapper.js";
import {
  describeExerciseResult,
  selectExerciseResultView,
} from "../features/exercise/exercise-result-projector.js";
import { ModeTabs } from "../features/exercise/ModeTabs.js";
import type { BattleMode } from "../features/exercise/ModeTabs.js";
import { ScoreSummaryHeader } from "../features/exercise/ScoreSummaryHeader.js";
import { BattleSetupLayout } from "../features/formation/BattleSetupLayout.js";
import { ExecutionParameterForm } from "../features/formation/ExecutionParameterForm.js";
import { FormationEditor } from "../features/formation/FormationEditor.js";
import { FormationResetControls } from "../features/formation/FormationResetControls.js";
import { formationReducer } from "../features/formation/formation-reducer.js";
import type { FormationAction } from "../features/formation/formation-reducer.js";
import { validateDraft } from "../features/formation/draft-validation.js";
import { buildBattleSimulationRequest } from "../features/formation/request-mapper.js";
import {
  createPersistedInitialState,
  createUnpersistedInitialState,
  useFormationPersistence,
} from "../features/formation/use-formation-persistence.js";
import { SubmitControls } from "../features/formation/SubmitControls.js";
import type { UseFormationStatPreviewOptions } from "../features/formation/use-formation-stat-preview.js";
import { useFormationStatPreview } from "../features/formation/use-formation-stat-preview.js";
import {
  enhancementForSide,
  memorySlotsForSide,
  slotsForSide,
} from "../features/formation/types.js";
import type { Side } from "../features/formation/types.js";
import { ValidationSummary } from "../features/formation/ValidationSummary.js";
import type { UseCatalogLoaderOptions } from "../features/catalog-selection/catalog-loader.js";
import { useCatalogLoader } from "../features/catalog-selection/catalog-loader.js";
import {
  definitionImageMap,
  memoryImageMap,
  unitImageMap,
} from "../features/catalog-selection/definition-image-map.js";
import { simulateTacticalExercise } from "../features/simulation/api-client.js";
import { SubmissionFeedback } from "../features/simulation/SubmissionFeedback.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import { useSimulationExecution } from "../features/simulation/use-simulation-execution.js";
import { BattleSummarySection } from "../features/summary/BattleSummarySection.js";
import { describeBattleResult } from "../features/summary/summary-projector.js";
import { OutcomeStrip } from "../features/summary/OutcomeStrip.js";
import type { TacticalExerciseRequest } from "../features/exercise/exercise-request-mapper.js";
import type {
  BattleSimulationCatalogResponse,
  TacticalExerciseResponse,
} from "../features/simulation/api-contract.js";
import { SelectionDialogs } from "./SelectionDialogs.js";
import { useBattleSimulatorViewModel } from "./use-battle-simulator-view-model.js";

export interface BattleSimulatorPageProps {
  readonly apiBaseUrl: string;
  readonly buildRevision?: string;
  readonly getCatalogImpl?: UseCatalogLoaderOptions["getCatalogImpl"];
  readonly simulateImpl?: UseSimulationExecutionOptions["simulateImpl"];
  readonly simulateTacticalExerciseImpl?: UseSimulationExecutionOptions<
    TacticalExerciseRequest,
    TacticalExerciseResponse
  >["simulateImpl"];
  readonly previewFormationStatsImpl?: UseFormationStatPreviewOptions["previewImpl"];
}

const SIMULATION_ENDPOINT = "POST /api/v1/battle-simulations";
const EXERCISE_ENDPOINT = "POST /api/v1/tactical-exercises";

export function BattleSimulatorPage({
  apiBaseUrl,
  buildRevision,
  getCatalogImpl,
  simulateImpl,
  simulateTacticalExerciseImpl,
  previewFormationStatsImpl,
}: BattleSimulatorPageProps) {
  const catalogLoader = useCatalogLoader(
    apiBaseUrl,
    getCatalogImpl !== undefined ? { getCatalogImpl } : {},
  );
  const [mode, setMode] = useState<BattleMode>("battle");
  // UI-AC-029: 前回セッションのdraftはlazy initで復元する（reducerを不純にしない）。
  const [battleState, battleDispatch] = useReducer(
    formationReducer,
    undefined,
    createPersistedInitialState,
  );
  // UI-AC-018: 演習draftはモード別の独立したsliceとして持つ。永続化
  // （01_UI要求・画面設計.md §5.9）は通常戦闘のdraftだけを対象にし、同じ
  // storage keyを2つのdraftが奪い合わないようにする。
  const [exerciseState, exerciseDispatch] = useReducer(
    formationReducer,
    undefined,
    createUnpersistedInitialState,
  );
  const catalog = catalogLoader.state;

  // UI-CMP-013: 実行stateをモードごとに分ける。abort controllerもexecutionIdの
  // 発番もhookインスタンスに閉じるため、旧モードの遅延応答は自分のsliceへしか
  // 届かず、他モードの最新stateを上書きできない。
  const battleExecution = useSimulationExecution(
    apiBaseUrl,
    simulateImpl !== undefined ? { simulateImpl } : {},
  );
  const exerciseExecution = useSimulationExecution<
    TacticalExerciseRequest,
    TacticalExerciseResponse
  >(apiBaseUrl, { simulateImpl: simulateTacticalExerciseImpl ?? simulateTacticalExercise });

  const battleView = useBattleSimulatorViewModel({
    catalog,
    draft: battleState.draft,
    execution: battleExecution.state,
    validate: validateDraft,
    buildRequest: buildBattleSimulationRequest,
  });
  const exerciseView = useBattleSimulatorViewModel({
    catalog,
    draft: exerciseState.draft,
    execution: exerciseExecution.state,
    validate: validateExerciseDraft,
    buildRequest: buildTacticalExerciseRequest,
  });

  const isExercise = mode === "exercise";
  const formState = isExercise ? exerciseState : battleState;
  const dispatch = isExercise ? exerciseDispatch : battleDispatch;
  const view = isExercise ? exerciseView : battleView;
  const execution = isExercise ? exerciseExecution : battleExecution;
  const { displayedViolations } = view;

  // UI-AC-027: 編成draftが変わるたびに開始時ステータスを取り直す。取得失敗は
  // 実行状態（`execution`）へ持ち込まない（docs/ui-design/03_API・データ連携設計.md §2.5）。
  const statPreview = useFormationStatPreview(apiBaseUrl, formState.draft, {
    mode: isExercise ? "TACTICAL_EXERCISE" : "NORMAL",
    ...(previewFormationStatsImpl !== undefined ? { previewImpl: previewFormationStatsImpl } : {}),
  });

  // 01_UI要求・画面設計.md §5.9: 入力の保存・復元・プリフィル。保存の失敗は
  // 画面へ出さず、保存以外の機能をそのまま続ける。
  const persistence = useFormationPersistence({
    draft: battleState.draft,
    editedDraft: formState.draft,
    editedDraftId: mode,
    ...(formState.lastEditedSlotKey === undefined
      ? {}
      : { lastEditedSlotKey: formState.lastEditedSlotKey }),
    catalog,
    violations: battleView.violations,
    dispatch: battleDispatch,
  });

  const { createDraftResetAction } = persistence;
  const resetActiveDraft = useCallback(() => {
    dispatch(createDraftResetAction());
  }, [dispatch, createDraftResetAction]);

  const { clearPlayerData } = persistence;
  // 手持ちデータは両モードの味方強化入力の共通の出所なので、消すときは両方の
  // draftから落とす（片方だけだと書き戻しeffectが残った値から復元してしまう）。
  const clearPlayerDataEverywhere = useCallback(() => {
    clearPlayerData();
    const action: FormationAction = { type: "allyEnhancementCleared" };
    exerciseDispatch(action);
  }, [clearPlayerData]);

  // 学園レベルは手持ちデータ（`mlgg:player-data`）の一部であり、モードに依らない
  // 味方の育成情報である（01_UI要求・画面設計.md §5.9）。モードごとのdraftへ同じ
  // 編集を配り、どちらのモードで開いても同じ値が出るようにする。敵側は都度入力の
  // 方針なので、編集中のモードだけへ配る。
  const changeAcademyLevel = useCallback(
    (side: Side, group: "unitTypes" | "attributes", key: string, value: number | "") => {
      const action: FormationAction = { type: "academyLevelChanged", side, group, key, value };
      if (side !== "ally") {
        dispatch(action);
        return;
      }
      battleDispatch(action);
      exerciseDispatch(action);
    },
    [dispatch],
  );

  const submit = () => {
    if (isExercise) {
      if (exerciseView.requestBuild.ok) {
        const { ok: _ok, ...input } = exerciseView.requestBuild;
        exerciseExecution.submit(input);
      }
      return;
    }
    if (battleView.requestBuild.ok) {
      const { ok: _ok, ...input } = battleView.requestBuild;
      battleExecution.submit(input);
    }
  };

  const renderAllyEditor = (readyCatalog: BattleSimulationCatalogResponse) => (
    <FormationEditor
      side="ally"
      slots={slotsForSide(formState.draft, "ally")}
      memoryDefinitionIds={memorySlotsForSide(formState.draft, "ally")}
      catalog={readyCatalog}
      violations={displayedViolations}
      disabled={view.formationDisabled}
      imageMap={definitionImageMap}
      enhancement={enhancementForSide(formState.draft, "ally")}
      statPreview={statPreview}
      onOpenUnitSelection={(slotKey) => {
        dispatch({ type: "selectionOpened", selection: { kind: "unit", slotKey } });
      }}
      onOpenMemorySelection={(side, index) => {
        dispatch({ type: "selectionOpened", selection: { kind: "memory", side, index } });
      }}
      onOpenUnitEnhancement={(slotKey) => {
        dispatch({ type: "selectionOpened", selection: { kind: "unitEnhancement", slotKey } });
      }}
      onEnhancementToggle={(side, enabled) => {
        dispatch({ type: "enhancementToggled", side, enabled });
      }}
      onAcademyLevelChange={changeAcademyLevel}
      onMoveUnit={(fromSlotKey, toSlotKey) => {
        dispatch({ type: "unitMoved", fromSlotKey, toSlotKey });
      }}
    />
  );

  return (
    <AppShell {...(buildRevision !== undefined ? { buildRevision } : {})}>
      <ModeTabs mode={mode} onChange={setMode} />

      {/* WAI-ARIA APG: `Tabs`が出す`aria-controls`の指す先を実在させる。モード
          切替はページ全体（設定・実行結果・詳細）を入れ替えるため、活性モードの
          内容全体を1つのtabpanelとして持つ。 */}
      <div role="tabpanel" id={`tabpanel-${mode}`} aria-labelledby={`tab-${mode}`}>
        <Panel
          step="01"
          title={isExercise ? "演習パラメータ" : "戦闘パラメータ"}
          meta={isExercise ? "FORMATION / MEMORY / EXERCISE" : "FORMATION / MEMORY / EXECUTION"}
        >
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
                ally={renderAllyEditor(catalog.response)}
                enemy={
                  isExercise ? (
                    <ExerciseEnemySlot
                      slots={slotsForSide(formState.draft, "enemy")}
                      catalog={catalog.response}
                      violations={displayedViolations}
                      disabled={view.formationDisabled}
                      imageMap={definitionImageMap}
                      statPreview={statPreview}
                      onOpenUnitSelection={(slotKey) => {
                        dispatch({ type: "selectionOpened", selection: { kind: "unit", slotKey } });
                      }}
                    />
                  ) : (
                    <FormationEditor
                      side="enemy"
                      slots={slotsForSide(formState.draft, "enemy")}
                      memoryDefinitionIds={memorySlotsForSide(formState.draft, "enemy")}
                      catalog={catalog.response}
                      violations={displayedViolations}
                      disabled={view.formationDisabled}
                      imageMap={definitionImageMap}
                      enhancement={enhancementForSide(formState.draft, "enemy")}
                      statPreview={statPreview}
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
                      onAcademyLevelChange={changeAcademyLevel}
                      onMoveUnit={(fromSlotKey, toSlotKey) => {
                        dispatch({ type: "unitMoved", fromSlotKey, toSlotKey });
                      }}
                    />
                  )
                }
              />

              <ExecutionParameterForm
                turnLimit={formState.draft.turnLimit}
                logLevel={formState.draft.logLevel}
                endpoint={isExercise ? EXERCISE_ENDPOINT : SIMULATION_ENDPOINT}
                disabled={view.formationDisabled}
                violations={displayedViolations}
                {...(isExercise ? { fixedTurnLimit: EXERCISE_TURN_LIMIT } : {})}
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
                submitLabel={isExercise ? "戦術演習を開始" : "戦闘を開始"}
                onSubmit={submit}
                onCancel={execution.cancel}
              />

              <FormationResetControls
                disabled={view.formationDisabled}
                onResetDraft={resetActiveDraft}
                onClearPlayerData={clearPlayerDataEverywhere}
              />
            </>
          ) : null}
        </Panel>

        {isExercise ? (
          <SubmissionFeedback
            state={exerciseExecution.state}
            isDirty={exerciseView.isDirty}
            successMessage="戦術演習が完了しました。"
            resultSummary={
              exerciseView.displayedSuccess === undefined
                ? ""
                : describeExerciseResult(exerciseView.displayedSuccess.response.result)
            }
            catalogRevisionMismatch={exerciseView.catalogRevisionMismatch}
            onReloadCatalog={catalogLoader.reload}
          />
        ) : (
          <SubmissionFeedback
            state={battleExecution.state}
            isDirty={battleView.isDirty}
            successMessage="戦闘が完了しました。"
            resultSummary={
              battleView.displayedSuccess === undefined
                ? ""
                : describeBattleResult(battleView.displayedSuccess.response.result)
            }
            catalogRevisionMismatch={battleView.catalogRevisionMismatch}
            onReloadCatalog={catalogLoader.reload}
          />
        )}

        {view.displayedSuccess !== undefined && !view.catalogRevisionMismatch ? (
          <>
            <Panel
              step="02"
              title={isExercise ? "演習サマリ" : "戦闘サマリ"}
              meta={isExercise ? "SCORE / BREAK / ROSTER" : "OUTCOME / ROSTER"}
            >
              {isExercise && exerciseView.displayedSuccess !== undefined ? (
                <BattleSummarySection
                  response={exerciseView.displayedSuccess.response}
                  {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
                  header={
                    <>
                      <ScoreSummaryHeader
                        result={exerciseView.displayedSuccess.response.result}
                        battleId={exerciseView.displayedSuccess.response.battleId}
                        catalogRevision={exerciseView.displayedSuccess.response.catalogRevision}
                      />
                      <BreakTimeline
                        breaks={
                          selectExerciseResultView(exerciseView.displayedSuccess.response.result)
                            .breaks
                        }
                      />
                    </>
                  }
                  imageMap={unitImageMap}
                />
              ) : null}
              {!isExercise && battleView.displayedSuccess !== undefined ? (
                <BattleSummarySection
                  response={battleView.displayedSuccess.response}
                  {...(catalog.status === "ready" ? { catalog: catalog.response } : {})}
                  header={
                    <OutcomeStrip
                      result={battleView.displayedSuccess.response.result}
                      turnLimit={battleView.displayedSuccess.request.turnLimit}
                      battleId={battleView.displayedSuccess.response.battleId}
                      catalogRevision={battleView.displayedSuccess.response.catalogRevision}
                    />
                  }
                  imageMap={unitImageMap}
                />
              ) : null}
            </Panel>
            <Panel
              step="03"
              title={isExercise ? "演習詳細データ" : "戦闘詳細データ"}
              meta="AUDIT TRAIL / RAW RESPONSE"
            >
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
          selectionDialog={formState.selectionDialog}
          draft={formState.draft}
          mode={mode}
          catalog={catalog.response}
          unitImageMap={unitImageMap}
          memoryImageMap={memoryImageMap}
          violations={displayedViolations}
          prefillEnhancementFor={persistence.prefillEnhancementFor}
          dispatch={dispatch}
        />
      ) : null}
    </AppShell>
  );
}
