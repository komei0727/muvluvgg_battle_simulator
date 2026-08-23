import { useMemo, useState } from "react";
import { Tabs } from "../../components/Tabs.js";
import { buildRosterIndex } from "./event-formatters.js";
import { EventCausalityTree } from "./EventCausalityTree.js";
import { EventTimeline } from "./EventTimeline.js";
import { RawJsonView } from "./RawJsonView.js";
import { StateTransitionTable } from "./StateTransitionTable.js";
import { UnitActionStateSection } from "./UnitActionStateSection.js";
import { EffectTraceSection } from "../effect-trace/EffectTraceSection.js";
import { selectRoster } from "../summary/summary-projector.js";
import type { LogLevel } from "../formation/types.js";
import type {
  BattleLogResponse,
  BattleSimulationCatalogResponse,
} from "../../shared/api/api-contract.js";
import styles from "./BattleDetailsSection.module.css";

export interface BattleDetailsSectionProps {
  readonly response: BattleLogResponse;
  readonly catalog?: BattleSimulationCatalogResponse;
  readonly logLevel: LogLevel;
}

type DetailsTab =
  | "events"
  | "transitions"
  | "json"
  | "actionState"
  | "causalityTree"
  | "effectTrace";

// causalityTreeを"events"と"transitions"の間へ挿入すると、
// 既存e2e/keyboard.spec.tsが検証する「時系列イベント --ArrowRight--> 状態遷移」
// のtab隣接関係が崩れる。既存tabの相対順序を変更せず、末尾に追加する。
const TAB_ITEMS: readonly { readonly id: DetailsTab; readonly label: string }[] = [
  { id: "events", label: "時系列イベント" },
  { id: "transitions", label: "状態遷移" },
  { id: "json", label: "レスポンスJSON" },
  { id: "actionState", label: "ユニット状態" },
  { id: "causalityTree", label: "因果ツリー" },
  { id: "effectTrace", label: "効果トレース" },
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
export function BattleDetailsSection({ response, catalog, logLevel }: BattleDetailsSectionProps) {
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

  // ログ方針刷新2/3（Issue #464）: `SUMMARY`実行のレスポンスはイベント・状態遷移・
  // `finalState`を持たない。tabを出したままにすると5つとも「空だが正常」に見え、
  // 実行が失敗したのか設定の問題なのか画面から区別できない。案内へ置き換える。
  if (logLevel === "SUMMARY") {
    return (
      <div className={styles["panel"]}>
        <p className={styles["notice"]}>
          詳細ログモード（DETAILED）で実行すると、時系列イベント・状態遷移・因果ツリー・ユニット状態・効果トレース・レスポンスJSONを閲覧できます。
        </p>
      </div>
    );
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
      {activeTab === "actionState" ? (
        <div role="tabpanel" id="tabpanel-actionState" aria-labelledby="tab-actionState">
          <UnitActionStateSection
            response={response}
            logLevel={logLevel}
            {...(catalog !== undefined ? { catalog } : {})}
          />
        </div>
      ) : null}
      {activeTab === "causalityTree" ? (
        <div role="tabpanel" id="tabpanel-causalityTree" aria-labelledby="tab-causalityTree">
          <EventCausalityTree events={response.events} roster={roster} />
        </div>
      ) : null}
      {activeTab === "effectTrace" ? (
        <div role="tabpanel" id="tabpanel-effectTrace" aria-labelledby="tab-effectTrace">
          <EffectTraceSection response={response} roster={roster} />
        </div>
      ) : null}
    </div>
  );
}
