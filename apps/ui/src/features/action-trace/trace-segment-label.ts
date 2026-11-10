// docs/ui-design/01_UI要求・画面設計.md §8.10「画面構成」。タイムライン・行動順・処理の一覧の
// 見出しに出す区間の名前。行動区間は行動者の表示名、システム区間は見出しの構造値から作る
// （`projectActionSegments`は文言を返さない）。
import { splitDisplayName } from "../../components/display-name.js";
import type { RosterIndex } from "../details/event-presentation.js";
import type { ActionSegment, SystemSegmentHeadline } from "./action-segment-projector.js";

const SIDE_LABEL: Readonly<Record<string, string>> = { ALLY: "味方", ENEMY: "敵" };

export function sideLabelOf(side: string | undefined): string {
  return side === undefined ? "不明" : (SIDE_LABEL[side] ?? side);
}

function headlineText(headline: SystemSegmentHeadline): string {
  switch (headline.kind) {
    case "BATTLE_STARTED":
      return "戦闘開始";
    case "TURN_STARTED":
      return `ターン${headline.turnNumber.toString()}開始`;
    case "TURN_COMPLETED":
      return `ターン${headline.turnNumber.toString()}終了`;
    case "FORMATION_DEPLOYED": {
      const side = headline.side !== undefined ? `${sideLabelOf(headline.side)}の` : "";
      return `${side}編成${headline.formationNumber?.toString() ?? ""}出撃`;
    }
    case "BATTLE_COMPLETED":
      return "戦闘終了";
    case "OTHER":
      return "システム処理";
  }
}

function shortHeadline(headline: SystemSegmentHeadline): string {
  switch (headline.kind) {
    case "BATTLE_STARTED":
      return "開始";
    case "TURN_STARTED":
      return `T${headline.turnNumber.toString()}`;
    case "TURN_COMPLETED":
      return "終了";
    case "FORMATION_DEPLOYED":
      return "出撃";
    case "BATTLE_COMPLETED":
      return "決着";
    case "OTHER":
      return "SYS";
  }
}

export interface SegmentLabel {
  /** 行動者の表示名の全文、またはシステム処理の見出し。 */
  readonly title: string;
  /** タイムラインの目盛りに出す短い名前。 */
  readonly short: string;
  /** 行動本体のスキル定義ID。 */
  readonly skill?: string;
}

export function segmentLabelOf(segment: ActionSegment, roster: RosterIndex): SegmentLabel {
  if (segment.kind === "SYSTEM") {
    return { title: headlineText(segment.headline), short: shortHeadline(segment.headline) };
  }
  const actor = segment.actorUnitId;
  const title = actor === undefined ? "行動者不明" : (roster.get(actor)?.displayName ?? actor);
  const skill = segment.mainSkill?.skillDefinitionId;
  return {
    title,
    short: splitDisplayName(title).name,
    ...(skill !== undefined ? { skill } : {}),
  };
}
