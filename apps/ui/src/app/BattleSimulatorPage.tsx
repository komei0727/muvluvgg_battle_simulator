import { useCallback, useState } from "react";
import { AppShell } from "../components/AppShell.js";
import type { BattleMode } from "../entities/battle-mode.js";
import type {
  TacticalExerciseRequest,
  TacticalExerciseResponse,
} from "../shared/api/api-contract.js";
import { ModeTabs } from "../features/exercise/ModeTabs.js";
import type { SelectionDialogState } from "../features/formation/formation-reducer.js";
import { usePlayerEnhancementPersistence } from "../features/formation/use-player-enhancement-persistence.js";
import type { UseFormationStatPreviewOptions } from "../features/formation/use-formation-stat-preview.js";
import type { UseCatalogLoaderOptions } from "../features/catalog-selection/catalog-loader.js";
import { useCatalogLoader } from "../features/catalog-selection/catalog-loader.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import type { UseExerciseStatisticsRunOptions } from "../features/exercise/use-exercise-statistics-run.js";

import { NormalBattleMode } from "./NormalBattleMode.js";
import { TacticalExerciseMode } from "./TacticalExerciseMode.js";

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
  readonly evaluateTacticalExerciseImpl?: UseExerciseStatisticsRunOptions["evaluateImpl"];
}

/**
 * モード選択・Catalog取得・味方の共有育成データ（学園レベル・レベルリンク・
 * ユニット強化）だけを持つ（REF-059 / Issue #604）。編成draft・実行状態・
 * 統計実行はモード別コンテナ（`NormalBattleMode`／`TacticalExerciseMode`）が持つ。
 *
 * 両コンテナは常時マウントしたまま、非活性時は`active=false`でnullを返すだけに
 * する——実行状態・統計実行はlocalStorageへ永続化されないため、タブ切替でアン
 * マウントすると再訪時に消えてしまう（`UI-CT-032`）。
 */
export function BattleSimulatorPage({
  apiBaseUrl,
  buildRevision,
  getCatalogImpl,
  simulateImpl,
  simulateTacticalExerciseImpl,
  previewFormationStatsImpl,
  evaluateTacticalExerciseImpl,
}: BattleSimulatorPageProps) {
  const catalogLoader = useCatalogLoader(
    apiBaseUrl,
    getCatalogImpl !== undefined ? { getCatalogImpl } : {},
  );
  // UI-AC-018: 戦術演習を既定モードにする。
  const [mode, setMode] = useState<BattleMode>("exercise");
  // UI-AC-034: プレビューの表示モード。編成の内容ではなく見え方なので、
  // formation-reducerのstateへ入れず保存対象にもしない。両陣営・全枠で共有する。
  const [showBaseStats, setShowBaseStats] = useState(false);
  // ダイアログ選択状態はモードに紐づかないPageのlocal state
  // （04_コンポーネント・状態管理設計.md §4、REF-058 / Issue #603）。
  // どのモードのcontainerを起点に開いたかに関わらず、開閉のON/OFFだけをここが持つ。
  const [selectionDialog, setSelectionDialog] = useState<SelectionDialogState>({ kind: "closed" });
  const closeSelectionDialog = useCallback(() => {
    setSelectionDialog({ kind: "closed" });
  }, []);

  const catalog = catalogLoader.state;
  // 味方の学園レベル・レベルリンク・ユニット強化はモードに依らない単一slice
  // （REF-058 / Issue #603）。モード別コンテナへは`withPlayerEnhancement`で重ね合わせる。
  const playerEnhancement = usePlayerEnhancementPersistence(catalog);

  return (
    <AppShell {...(buildRevision !== undefined ? { buildRevision } : {})}>
      <ModeTabs
        mode={mode}
        onChange={(nextMode) => {
          setMode(nextMode);
          closeSelectionDialog();
        }}
      />

      <NormalBattleMode
        active={mode === "battle"}
        apiBaseUrl={apiBaseUrl}
        catalog={catalog}
        onReloadCatalog={catalogLoader.reload}
        showBaseStats={showBaseStats}
        onShowBaseStatsChange={setShowBaseStats}
        playerEnhancement={playerEnhancement}
        selectionDialog={selectionDialog}
        onRequestSelectionDialog={setSelectionDialog}
        onCloseSelectionDialog={closeSelectionDialog}
        {...(simulateImpl !== undefined ? { simulateImpl } : {})}
        {...(previewFormationStatsImpl !== undefined ? { previewFormationStatsImpl } : {})}
      />
      <TacticalExerciseMode
        active={mode === "exercise"}
        apiBaseUrl={apiBaseUrl}
        catalog={catalog}
        onReloadCatalog={catalogLoader.reload}
        showBaseStats={showBaseStats}
        onShowBaseStatsChange={setShowBaseStats}
        playerEnhancement={playerEnhancement}
        selectionDialog={selectionDialog}
        onRequestSelectionDialog={setSelectionDialog}
        onCloseSelectionDialog={closeSelectionDialog}
        {...(simulateTacticalExerciseImpl !== undefined ? { simulateTacticalExerciseImpl } : {})}
        {...(previewFormationStatsImpl !== undefined ? { previewFormationStatsImpl } : {})}
        {...(evaluateTacticalExerciseImpl !== undefined ? { evaluateTacticalExerciseImpl } : {})}
      />
    </AppShell>
  );
}
