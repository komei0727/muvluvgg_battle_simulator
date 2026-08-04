// Mirrors docs/ui-design/03_API・データ連携設計.md §12「イベント表示」:
// typeごとのformatterがdetailsをnarrowingし、formatterがない、またはdetails
// が想定shapeでない場合は generic fallback (title=event.type, summary=
// `source → targets`, details=JSON整形表示, severity=neutral) を使う
// (UI-AC-011)。英語のerror messageやID命名規則を解析して日本語化しない。
//
// このファイルはイベントカテゴリ別のregistryを合成して`formatEvent`を公開する
// だけを担う。formatter本体はカテゴリ別ファイルが持つ。

import { battleFlowEventFormatters } from "./battle-flow-event-formatters.js";
import { damageEventFormatters } from "./damage-event-formatters.js";
import { effectEventFormatters } from "./effect-event-formatters.js";
import {
  buildRosterIndex,
  mergeDisjointFormatters,
  resolveDisplayName,
} from "./event-presentation.js";
import { resourceEventFormatters } from "./resource-event-formatters.js";
import { skillEventFormatters } from "./skill-event-formatters.js";
import type { EventPresentation, EventSeverity, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

// 共通の型・helperは`event-presentation.ts`が持つ（DMG-010／Issue #191で
// M8ダメージformatterを別ファイルへ分けた際に循環importを避けるため）。
// 既存の利用側importを壊さないよう、ここから再exportする。
export { buildRosterIndex, resolveDisplayName };
export type { EventPresentation, EventSeverity, RosterIndex };

// 新しいtypeはいずれか1つのカテゴリだけへ追加する。カテゴリを増やすときも必ず
// ここへ足す（`mergeDisjointFormatters`がtype重複を検出できるのは、合成元として
// 渡されたregistryだけであるため）。
const eventFormatters = mergeDisjointFormatters({
  battleFlow: battleFlowEventFormatters,
  skill: skillEventFormatters,
  resource: resourceEventFormatters,
  // M7-009（Issue #182）: 効果・状態異常・回復（07_UI実装・拡張計画.md §11）。
  effect: effectEventFormatters,
  // DMG-010（Issue #191）: M8 高度ダメージ（07_UI実装・拡張計画.md §12）。
  // `DAMAGE_APPLIED`もM8で内訳フィールドを得たため、そちらのregistryが持つ。
  damage: damageEventFormatters,
});

function genericFallback(event: BattleLogEventResponse, roster: RosterIndex): EventPresentation {
  const sourceUnitId = event["sourceUnitId"];
  const targetUnitIds = event["targetUnitIds"];
  const sourceName =
    typeof sourceUnitId === "string" ? resolveDisplayName(roster, sourceUnitId) : "-";
  const targetNames =
    Array.isArray(targetUnitIds) && targetUnitIds.length > 0
      ? targetUnitIds
          .filter((id): id is string => typeof id === "string")
          .map((id) => resolveDisplayName(roster, id))
          .join(", ")
      : "-";
  return {
    title: event.type,
    summary: `${sourceName} → ${targetNames}`,
    details: event["details"],
    severity: "neutral",
  };
}

export function formatEvent(event: BattleLogEventResponse, roster: RosterIndex): EventPresentation {
  const formatter = eventFormatters[event.type];
  return formatter?.(event, roster) ?? genericFallback(event, roster);
}
