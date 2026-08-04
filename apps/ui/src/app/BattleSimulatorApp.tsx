import type { ApiBaseUrlResult } from "../lib/env.js";
import type { UseCatalogLoaderOptions } from "../features/catalog-selection/catalog-loader.js";
import type { UseSimulationExecutionOptions } from "../features/simulation/use-simulation-execution.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

export interface BattleSimulatorAppProps {
  readonly apiBaseUrlResult: ApiBaseUrlResult;
  readonly buildRevision?: string;
  // Catalog取得・戦闘実行のAPI clientはどちらもこの層で差し替えられる必要が
  // ある（片方だけ委譲すると、もう片方だけ実fetchへ落ちる）。
  readonly getCatalogImpl?: UseCatalogLoaderOptions["getCatalogImpl"];
  readonly simulateImpl?: UseSimulationExecutionOptions["simulateImpl"];
}

const CONFIG_ERROR_MESSAGE =
  "API接続先の設定が不正なため、アプリケーションを起動できません。運用担当者へ連絡してください。";

export function BattleSimulatorApp({
  apiBaseUrlResult,
  buildRevision,
  getCatalogImpl,
  simulateImpl,
}: BattleSimulatorAppProps) {
  if (!apiBaseUrlResult.ok) {
    return <p role="alert">{CONFIG_ERROR_MESSAGE}</p>;
  }

  return (
    <BattleSimulatorPage
      apiBaseUrl={apiBaseUrlResult.url}
      {...(buildRevision !== undefined ? { buildRevision } : {})}
      {...(getCatalogImpl !== undefined ? { getCatalogImpl } : {})}
      {...(simulateImpl !== undefined ? { simulateImpl } : {})}
    />
  );
}
