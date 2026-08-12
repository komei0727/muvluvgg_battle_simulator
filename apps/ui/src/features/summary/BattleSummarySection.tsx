import { useMemo } from "react";
import type { ReactNode } from "react";
import { selectBattleSummary } from "./summary-projector.js";
import { UnitSummaryTable } from "./UnitSummaryTable.js";
import type {
  BattleLogResponse,
  BattleSimulationCatalogResponse,
} from "../simulation/api-contract.js";
import styles from "./BattleSummarySection.module.css";

export interface BattleSummarySectionProps {
  readonly response: BattleLogResponse;
  readonly catalog?: BattleSimulationCatalogResponse;
  /**
   * 結果ヘッダー。通常戦闘は`OutcomeStrip`、戦術演習は`ScoreSummaryHeader`＋
   * `BreakTimeline`（`UI-CMP-012`）。演習は勝敗を持たないため、集計表と共通の
   * 部分だけをこのcomponentが持ち、結果DTOに依存する表示は呼び出し側が渡す。
   */
  readonly header: ReactNode;
  readonly imageMap?: Readonly<Record<string, string>>;
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
export function BattleSummarySection({
  response,
  catalog,
  header,
  imageMap,
}: BattleSummarySectionProps) {
  const projection = useMemo(
    () => selectBattleSummary(response, catalog ?? EMPTY_CATALOG),
    [response, catalog],
  );

  return (
    <div>
      {header}
      {projection.hasProjectionWarning ? (
        <p className={styles["warning"]} role="alert">
          一部イベントを集計できませんでした。
        </p>
      ) : null}
      <div className={styles["grid"]}>
        <UnitSummaryTable
          side="ally"
          rows={projection.allyRows}
          {...(imageMap !== undefined ? { imageMap } : {})}
        />
        <UnitSummaryTable
          side="enemy"
          rows={projection.enemyRows}
          {...(imageMap !== undefined ? { imageMap } : {})}
        />
      </div>
    </div>
  );
}
