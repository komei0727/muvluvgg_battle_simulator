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

function nameOf(roster: RosterIndex, battleUnitId: string): string {
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
  const sourceName = nameOf(roster, sourceUnitId);
  const targetName = nameOf(roster, details["targetUnitId"]);
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
    summary: `${nameOf(roster, details["unitId"])}が戦闘不能になりました。`,
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
    typeof details["effectiveActionType"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${nameOf(roster, details["actorUnitId"])}が行動を開始しました（${details["effectiveActionType"]}）。`,
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
  ACTION_STARTED: formatActionStarted,
  DAMAGE_APPLIED: formatDamageApplied,
  UNIT_DEFEATED: formatUnitDefeated,
  BATTLE_COMPLETED: formatBattleCompleted,
};

function genericFallback(event: BattleLogEventResponse, roster: RosterIndex): EventPresentation {
  const sourceUnitId = event["sourceUnitId"];
  const targetUnitIds = event["targetUnitIds"];
  const sourceName = typeof sourceUnitId === "string" ? nameOf(roster, sourceUnitId) : "-";
  const targetNames =
    Array.isArray(targetUnitIds) && targetUnitIds.length > 0
      ? targetUnitIds
          .filter((id): id is string => typeof id === "string")
          .map((id) => nameOf(roster, id))
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
