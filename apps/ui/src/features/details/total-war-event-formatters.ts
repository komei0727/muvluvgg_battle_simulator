// docs/ui-design/03_API・データ連携設計.md §12.3: 総力戦（R-TWR-01）でだけ現れるイベント。
// detailsが想定shapeでなければ`undefined`を返し、`formatEvent`のgeneric fallbackへ落とす。
import { resolveDisplayName } from "./event-presentation.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

const SIDE_LABELS: Readonly<Record<string, string>> = { ALLY: "味方", ENEMY: "敵" };

function sideLabel(side: string): string {
  return SIDE_LABELS[side] ?? side;
}

function formatFormationDeployed(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["side"] !== "string" ||
    typeof details["formationNumber"] !== "number" ||
    !Array.isArray(details["battleUnitIds"]) ||
    !details["battleUnitIds"].every((id) => typeof id === "string")
  ) {
    return undefined;
  }
  const names = (details["battleUnitIds"] as readonly string[])
    .map((id) => resolveDisplayName(roster, id))
    .join(", ");
  return {
    title: event.type,
    summary: `${sideLabel(details["side"])}の編成${String(details["formationNumber"])}が出撃: ${names}`,
    details,
    severity: "neutral",
  };
}

function formatFormationDefeated(event: BattleLogEventResponse): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["side"] !== "string" ||
    typeof details["formationNumber"] !== "number" ||
    typeof details["remainingReserveCount"] !== "number"
  ) {
    return undefined;
  }
  const side = details["side"];
  return {
    title: event.type,
    summary: `${sideLabel(side)}の編成${String(details["formationNumber"])}が全滅（控え残り${String(details["remainingReserveCount"])}）`,
    details,
    severity: side === "ENEMY" ? "positive" : side === "ALLY" ? "negative" : "neutral",
  };
}

export const totalWarEventFormatters: Readonly<Record<string, EventFormatter>> = {
  FORMATION_DEPLOYED: formatFormationDeployed,
  FORMATION_DEFEATED: formatFormationDefeated,
};
