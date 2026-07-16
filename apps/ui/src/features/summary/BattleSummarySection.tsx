import { useMemo } from "react";
import { OutcomeStrip } from "./OutcomeStrip.js";
import { selectBattleSummary } from "./summary-projector.js";
import { UnitSummaryTable } from "./UnitSummaryTable.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
} from "../simulation/api-contract.js";
import styles from "./BattleSummarySection.module.css";

export interface BattleSummarySectionProps {
  readonly response: BattleSimulationResponse;
  readonly catalog?: BattleSimulationCatalogResponse;
  readonly turnLimit: number;
}

const EMPTY_CATALOG: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "",
  units: [],
  memories: [],
};

// docs/ui-design/04_コンポーネント・状態管理設計.md §3 BattleSummarySection:
// API DTOを直接集計せず、selectBattleSummaryの結果だけを描画する。catalogが
// 一時的に「ready」でない場合(reload中など)もdisplayNameがunitDefinitionId
// へfallbackするだけで表示自体は継続する。
export function BattleSummarySection({ response, catalog, turnLimit }: BattleSummarySectionProps) {
  const result = useMemo(
    () => selectBattleSummary(response, catalog ?? EMPTY_CATALOG),
    [response, catalog],
  );

  return (
    <div>
      <OutcomeStrip
        result={response.result}
        turnLimit={turnLimit}
        battleId={response.battleId}
        catalogRevision={response.catalogRevision}
      />
      {!result.ok ? (
        <p className={styles["warning"]} role="alert">
          レスポンスの形式が想定と異なります。
        </p>
      ) : (
        <>
          {result.projection.hasProjectionWarning ? (
            <p className={styles["warning"]} role="alert">
              一部イベントを集計できませんでした。
            </p>
          ) : null}
          <div className={styles["grid"]}>
            <UnitSummaryTable side="ally" rows={result.projection.allyRows} />
            <UnitSummaryTable side="enemy" rows={result.projection.enemyRows} />
          </div>
        </>
      )}
    </div>
  );
}
