// docs/ui-design/03_API・データ連携設計.md §12「イベント表示」のうち、戦闘・ターン・
// 行動順・行動そのものの進行を表すイベント。共通の型・helperは
// `event-presentation.ts`が持つ（formatter群の各ファイル間で循環importを避けるため）。
import { resolveDisplayName } from "./event-presentation.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

function formatBattleStarted(event: BattleLogEventResponse): EventPresentation | undefined {
  const details = event["details"];
  if (!isRecord(details) || typeof details["turnLimit"] !== "number") {
    return undefined;
  }
  return {
    title: event.type,
    summary: `戦闘を開始しました（ターン上限 ${details["turnLimit"]}）。`,
    details,
    severity: "neutral",
  };
}

function formatTurnStarted(event: BattleLogEventResponse): EventPresentation | undefined {
  const details = event["details"];
  if (!isRecord(details) || typeof details["turnNumber"] !== "number") {
    return undefined;
  }
  return {
    title: event.type,
    summary: `ターン${details["turnNumber"]}を開始しました。`,
    details,
    severity: "neutral",
  };
}

function formatActionQueueCreated(event: BattleLogEventResponse): EventPresentation | undefined {
  const details = event["details"];
  const reservations = details && isRecord(details) ? details["reservations"] : undefined;
  if (
    !isRecord(details) ||
    typeof details["cycleNumber"] !== "number" ||
    !Array.isArray(reservations)
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `周回${details["cycleNumber"]}の行動順を生成しました（${reservations.length}件）。`,
    details,
    severity: "neutral",
  };
}

function formatActionQueueReordered(event: BattleLogEventResponse): EventPresentation | undefined {
  const details = event["details"];
  if (!isRecord(details) || !Array.isArray(details["before"]) || !Array.isArray(details["after"])) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `速度変化により未行動者の行動順を並べ替えました（${details["after"].length}件）。`,
    details,
    severity: "neutral",
  };
}

function formatActionReservationRemoved(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["reason"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の行動予約を除去しました（理由: ${details["reason"]}）。`,
    details,
    severity: "neutral",
  };
}

function formatActionStarted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["effectiveActionType"] !== "string" ||
    typeof details["apBefore"] !== "number" ||
    typeof details["apAfter"] !== "number" ||
    typeof details["exBefore"] !== "number" ||
    typeof details["exAfter"] !== "number"
  ) {
    return undefined;
  }
  const waitReason = details["waitReason"];
  const waitReasonText = typeof waitReason === "string" ? ` 待機理由: ${waitReason}` : "";
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}が行動を開始しました（${details["effectiveActionType"]}）。AP ${details["apBefore"]} → ${details["apAfter"]} / EX ${details["exBefore"]} → ${details["exAfter"]}${waitReasonText}`,
    details,
    severity: "neutral",
  };
}

function formatActionWaited(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["waitReason"] !== "string" ||
    typeof details["consumedResource"] !== "string" ||
    typeof details["consumedAmount"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}が待機しました（理由: ${details["waitReason"]}、消費: ${details["consumedResource"]} ${details["consumedAmount"]}）。`,
    details,
    severity: "neutral",
  };
}

function formatUnitDefeated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (!isRecord(details) || typeof details["unitId"] !== "string") {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["unitId"])}が戦闘不能になりました。`,
    details,
    severity: "negative",
  };
}

function formatBattleCompleted(event: BattleLogEventResponse): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["outcome"] !== "string" ||
    typeof details["completionReason"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `戦闘が終了しました（${details["outcome"]} / ${details["completionReason"]}）。`,
    details,
    severity: "neutral",
  };
}

export const battleFlowEventFormatters: Readonly<Record<string, EventFormatter>> = {
  BATTLE_STARTED: formatBattleStarted,
  TURN_STARTED: formatTurnStarted,
  ACTION_QUEUE_CREATED: formatActionQueueCreated,
  ACTION_QUEUE_REORDERED: formatActionQueueReordered,
  ACTION_RESERVATION_REMOVED: formatActionReservationRemoved,
  ACTION_STARTED: formatActionStarted,
  ACTION_WAITED: formatActionWaited,
  UNIT_DEFEATED: formatUnitDefeated,
  BATTLE_COMPLETED: formatBattleCompleted,
};
