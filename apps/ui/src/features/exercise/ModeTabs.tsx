import { Tabs } from "../../components/Tabs.js";
import type { BattleMode } from "../../entities/battle-mode.js";

export interface ModeTabsProps {
  readonly mode: BattleMode;
  readonly onChange: (mode: BattleMode) => void;
}

const MODE_ITEMS: readonly { readonly id: BattleMode; readonly label: string }[] = [
  { id: "battle", label: "通常戦闘" },
  { id: "exercise", label: "戦術演習" },
];

// UI-CMP-010 / UI-AC-018: 通常戦闘と戦術演習の表示・入力・結果を切り替える。
// keyboard操作と`aria-selected`はcomponents/Tabs.tsxのroving tabindex実装が持つ
// （WAI-ARIA APG「Tabs with Automatic Activation」）。
export function ModeTabs({ mode, onChange }: ModeTabsProps) {
  return (
    <Tabs
      label="戦闘モード"
      items={MODE_ITEMS}
      activeId={mode}
      onChange={(id) => {
        onChange(id as BattleMode);
      }}
    />
  );
}
