import type { ApiBaseUrlResult } from "../lib/env.js";
import type { UseCatalogLoaderOptions } from "../features/catalog-selection/catalog-loader.js";
import { BattleSimulatorPage } from "./BattleSimulatorPage.js";

export interface BattleSimulatorAppProps {
  readonly apiBaseUrlResult: ApiBaseUrlResult;
  readonly buildRevision?: string;
  readonly getCatalogImpl?: UseCatalogLoaderOptions["getCatalogImpl"];
}

const CONFIG_ERROR_MESSAGE =
  "API接続先の設定が不正なため、アプリケーションを起動できません。運用担当者へ連絡してください。";

// Simulation execution (submit/cancel/rerun) and result display are
// delivered by later M4.5 UI issues (#96-#97).
export function BattleSimulatorApp({
  apiBaseUrlResult,
  buildRevision,
  getCatalogImpl,
}: BattleSimulatorAppProps) {
  if (!apiBaseUrlResult.ok) {
    return <p role="alert">{CONFIG_ERROR_MESSAGE}</p>;
  }

  return (
    <BattleSimulatorPage
      apiBaseUrl={apiBaseUrlResult.url}
      {...(buildRevision !== undefined ? { buildRevision } : {})}
      {...(getCatalogImpl !== undefined ? { getCatalogImpl } : {})}
    />
  );
}
