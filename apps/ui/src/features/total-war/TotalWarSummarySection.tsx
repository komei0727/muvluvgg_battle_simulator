import { useMemo } from "react";
import { BattleSummarySection } from "../summary/BattleSummarySection.js";
import type {
  BattleSimulationCatalogResponse,
  TotalWarRequest,
  TotalWarResponse,
} from "../../shared/api/api-contract.js";
import { StageHistoryTable } from "./StageHistoryTable.js";
import { TotalWarOutcomeStrip } from "./TotalWarOutcomeStrip.js";
import { selectTotalWarResultView } from "./total-war-result-projector.js";
import type { TotalWarRosterEntry } from "../../entities/roster.js";

export interface TotalWarSummarySectionProps {
  readonly response: TotalWarResponse;
  /** 撃破された編成数の分母（送信した編成数）を取る。 */
  readonly request: TotalWarRequest;
  readonly roster: readonly TotalWarRosterEntry[];
  readonly catalog?: BattleSimulationCatalogResponse;
  readonly imageMap?: Readonly<Record<string, string>>;
}

// docs/ui-design/01_UI要求・画面設計.md §7.5: 結果ヘッダー・戦闘履歴・ユニット別表。
// ユニット別表は通常戦闘の部品へ`unitRoster`由来のRosterを渡して再利用する（UI-CMP-040）。
export function TotalWarSummarySection({
  response,
  request,
  roster,
  catalog,
  imageMap,
}: TotalWarSummarySectionProps) {
  const view = useMemo(() => selectTotalWarResultView(response, request), [response, request]);
  return (
    <BattleSummarySection
      response={response}
      roster={roster}
      {...(catalog !== undefined ? { catalog } : {})}
      {...(imageMap !== undefined ? { imageMap } : {})}
      header={
        <>
          <TotalWarOutcomeStrip view={view} />
          <StageHistoryTable stages={view.stages} />
        </>
      }
    />
  );
}
