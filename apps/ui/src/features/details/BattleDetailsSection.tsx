import { useMemo, useState } from "react";
import { Tabs } from "../../components/Tabs.js";
import { buildRosterIndex } from "./event-formatters.js";
import { EventTimeline } from "./EventTimeline.js";
import { RawJsonView } from "./RawJsonView.js";
import { StateTransitionTable } from "./StateTransitionTable.js";
import { selectRoster } from "../summary/summary-projector.js";
import type {
  BattleSimulationCatalogResponse,
  BattleSimulationResponse,
} from "../simulation/api-contract.js";
import styles from "./BattleDetailsSection.module.css";

export interface BattleDetailsSectionProps {
  readonly response: BattleSimulationResponse;
  readonly catalog?: BattleSimulationCatalogResponse;
}

type DetailsTab = "events" | "transitions" | "json";

const TAB_ITEMS: readonly { readonly id: DetailsTab; readonly label: string }[] = [
  { id: "events", label: "時系列イベント" },
  { id: "transitions", label: "状態遷移" },
  { id: "json", label: "レスポンスJSON" },
];

const EMPTY_CATALOG: BattleSimulationCatalogResponse = {
  schemaVersion: 1,
  catalogRevision: "",
  units: [],
  memories: [],
};

// docs/ui-design/01_UI要求・画面設計.md §8, 04_コンポーネント・状態管理設計.md
// §2 BattleDetailsSection: イベント・状態遷移・JSONを1ページ内のtabで切り替
// える(UI-AC-010)。stateTransitionIndexを持つイベントから対応する状態遷移
// へ移動できる(§8.1)。
export function BattleDetailsSection({ response, catalog }: BattleDetailsSectionProps) {
  const [activeTab, setActiveTab] = useState<DetailsTab>("events");
  const [highlightedTransitionIndex, setHighlightedTransitionIndex] = useState<number | undefined>(
    undefined,
  );

  const roster = useMemo(
    () => buildRosterIndex(selectRoster(response, catalog ?? EMPTY_CATALOG)),
    [response, catalog],
  );

  function jumpToTransition(index: number) {
    setHighlightedTransitionIndex(index);
    setActiveTab("transitions");
  }

  return (
    <div className={styles["panel"]}>
      <Tabs
        label="戦闘詳細"
        items={TAB_ITEMS}
        activeId={activeTab}
        onChange={(id) => {
          setActiveTab(id as DetailsTab);
        }}
      />
      {activeTab === "events" ? (
        <div role="tabpanel" id="tabpanel-events" aria-labelledby="tab-events">
          <EventTimeline
            events={response.events}
            roster={roster}
            onJumpToTransition={jumpToTransition}
          />
        </div>
      ) : null}
      {activeTab === "transitions" ? (
        <div role="tabpanel" id="tabpanel-transitions" aria-labelledby="tab-transitions">
          <StateTransitionTable
            transitions={response.stateTransitions}
            {...(highlightedTransitionIndex !== undefined
              ? { highlightedIndex: highlightedTransitionIndex }
              : {})}
          />
        </div>
      ) : null}
      {activeTab === "json" ? (
        <div role="tabpanel" id="tabpanel-json" aria-labelledby="tab-json">
          <RawJsonView value={response} />
        </div>
      ) : null}
    </div>
  );
}
