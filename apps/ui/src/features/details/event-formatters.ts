// Mirrors docs/ui-design/03_API・データ連携設計.md §12「イベント表示」:
// typeごとのformatterがdetailsをnarrowingし、formatterがない、またはdetails
// が想定shapeでない場合は generic fallback (title=event.type, summary=
// `source → targets`, details=JSON整形表示, severity=neutral) を使う
// (UI-AC-011)。英語のerror messageやID命名規則を解析して日本語化しない。

import type { RosterEntry } from "../summary/summary-projector.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

export type EventSeverity = "neutral" | "positive" | "negative";

export interface EventPresentation {
  readonly title: string;
  readonly summary: string;
  readonly details: unknown;
  readonly severity: EventSeverity;
}

export type RosterIndex = ReadonlyMap<string, RosterEntry>;

export function buildRosterIndex(roster: readonly RosterEntry[]): RosterIndex {
  return new Map(roster.map((entry) => [entry.battleUnitId, entry] as const));
}

export function resolveDisplayName(roster: RosterIndex, battleUnitId: string): string {
  return roster.get(battleUnitId)?.displayName ?? battleUnitId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type EventFormatter = (
  event: BattleLogEventResponse,
  roster: RosterIndex,
) => EventPresentation | undefined;

function formatDamageApplied(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  const sourceUnitId = event["sourceUnitId"];
  if (
    !isRecord(details) ||
    typeof sourceUnitId !== "string" ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["hitPointDamage"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  const sourceName = resolveDisplayName(roster, sourceUnitId);
  const targetName = resolveDisplayName(roster, details["targetUnitId"]);
  return {
    title: event.type,
    summary: `${sourceName} → ${targetName} に ${details["hitPointDamage"]} ダメージ。HP ${details["hpBefore"]} → ${details["hpAfter"]}`,
    details,
    severity: "negative",
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

function formatCooldownStarted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["initialRemaining"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のスキル「${details["skillDefinitionId"]}」のクールタイムを設定しました（残り${details["initialRemaining"]}）。`,
    details,
    severity: "neutral",
  };
}

function formatCooldownReduced(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["before"] !== "number" ||
    typeof details["after"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のスキル「${details["skillDefinitionId"]}」のクールタイムが${details["before"]} → ${details["after"]}になりました。`,
    details,
    severity: "neutral",
  };
}

function formatCooldownCompleted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のスキル「${details["skillDefinitionId"]}」のクールタイムが完了しました。`,
    details,
    severity: "neutral",
  };
}

function formatChargeStarted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}がスキル「${details["skillDefinitionId"]}」のチャージを開始しました。`,
    details,
    severity: "neutral",
  };
}

function formatChargeReleased(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のチャージ「${details["skillDefinitionId"]}」が発動しました。`,
    details,
    severity: "neutral",
  };
}

function formatPassiveActivated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["ppBefore"] !== "number" ||
    typeof details["ppAfter"] !== "number" ||
    typeof details["exBefore"] !== "number" ||
    typeof details["exAfter"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のパッシブスキル「${details["skillDefinitionId"]}」が発動しました。PP ${details["ppBefore"]} → ${details["ppAfter"]} / EX ${details["exBefore"]} → ${details["exAfter"]}`,
    details,
    severity: "neutral",
  };
}

function formatPassiveResolved(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["resolvedStepCount"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のパッシブスキル「${details["skillDefinitionId"]}」の効果解決が完了しました（${details["resolvedStepCount"]}step）。`,
    details,
    severity: "neutral",
  };
}

function formatPassiveInterrupted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["reason"] !== "string" ||
    typeof details["unresolvedEffectCount"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のパッシブスキル「${details["skillDefinitionId"]}」が中断しました（理由: ${details["reason"]}、未解決効果${details["unresolvedEffectCount"]}件）。`,
    details,
    severity: "negative",
  };
}

function formatPassivePointConsumed(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["before"] !== "number" ||
    typeof details["after"] !== "number" ||
    typeof details["consumedAmount"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のパッシブスキル「${details["skillDefinitionId"]}」がPPを消費しました。PP ${details["before"]} → ${details["after"]}（消費${details["consumedAmount"]}）。`,
    details,
    severity: "neutral",
  };
}

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

const eventFormatters: Readonly<Record<string, EventFormatter>> = {
  BATTLE_STARTED: formatBattleStarted,
  TURN_STARTED: formatTurnStarted,
  ACTION_QUEUE_CREATED: formatActionQueueCreated,
  ACTION_QUEUE_REORDERED: formatActionQueueReordered,
  ACTION_RESERVATION_REMOVED: formatActionReservationRemoved,
  ACTION_STARTED: formatActionStarted,
  ACTION_WAITED: formatActionWaited,
  COOLDOWN_STARTED: formatCooldownStarted,
  COOLDOWN_REDUCED: formatCooldownReduced,
  COOLDOWN_COMPLETED: formatCooldownCompleted,
  CHARGE_STARTED: formatChargeStarted,
  CHARGE_RELEASED: formatChargeReleased,
  DAMAGE_APPLIED: formatDamageApplied,
  UNIT_DEFEATED: formatUnitDefeated,
  BATTLE_COMPLETED: formatBattleCompleted,
  PASSIVE_ACTIVATED: formatPassiveActivated,
  PASSIVE_RESOLVED: formatPassiveResolved,
  PASSIVE_INTERRUPTED: formatPassiveInterrupted,
  PASSIVE_POINT_CONSUMED: formatPassivePointConsumed,
  RESOURCE_CHANGED: formatResourceChanged,
  EXTRA_GAUGE_INCREASED: formatExtraGaugeIncreased,
  EXTRA_GAUGE_OVERFLOW_DISCARDED: formatExtraGaugeOverflowDiscarded,
};

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
