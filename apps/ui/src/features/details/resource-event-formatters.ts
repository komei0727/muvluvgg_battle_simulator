// docs/ui-design/03_API・データ連携設計.md §12「イベント表示」のうち、リソース
// （HP・AP・PPなど）とEXゲージの増減を表すイベント。共通の型・helperは
// `event-presentation.ts`が持つ（formatter群の各ファイル間で循環importを避けるため）。
import { resolveDisplayName } from "./event-presentation.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

function formatResourceChanged(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["resource"] !== "string" ||
    typeof details["before"] !== "number" ||
    typeof details["after"] !== "number" ||
    typeof details["reason"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の${details["resource"]}が${details["before"]} → ${details["after"]}になりました（理由: ${details["reason"]}）。`,
    details,
    severity: "neutral",
  };
}

function formatExtraGaugeIncreased(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["causeResource"] !== "string" ||
    typeof details["before"] !== "number" ||
    typeof details["after"] !== "number" ||
    typeof details["increasedAmount"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}のEXゲージが${details["before"]} → ${details["after"]}に増加しました（${details["causeResource"]}消費起因、+${details["increasedAmount"]}）。`,
    details,
    severity: "neutral",
  };
}

function formatExtraGaugeOverflowDiscarded(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["requestedAmount"] !== "number" ||
    typeof details["actualAmount"] !== "number" ||
    typeof details["discardedAmount"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}のEXゲージが上限を超えたため${details["discardedAmount"]}を切り捨てました（要求${details["requestedAmount"]} → 実際${details["actualAmount"]}）。`,
    details,
    severity: "neutral",
  };
}

export const resourceEventFormatters: Readonly<Record<string, EventFormatter>> = {
  RESOURCE_CHANGED: formatResourceChanged,
  EXTRA_GAUGE_INCREASED: formatExtraGaugeIncreased,
  EXTRA_GAUGE_OVERFLOW_DISCARDED: formatExtraGaugeOverflowDiscarded,
};
