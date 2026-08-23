// docs/ui-design/03_API・データ連携設計.md §12「イベント表示」のうち、スキルの
// クールタイム・チャージ・パッシブのライフサイクルを表すイベント。共通の型・helperは
// `event-presentation.ts`が持つ（formatter群の各ファイル間で循環importを避けるため）。
import { resolveDisplayName } from "./event-presentation.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

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

// R-SKL-05/R-STS-03（Issue #180）: 凍結・気絶とチャージの相互作用。
function formatChargeCancelled(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string" ||
    typeof details["reason"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}のチャージ「${details["skillDefinitionId"]}」が中断されました（理由: ${details["reason"]}）。`,
    details,
    severity: "negative",
  };
}

function formatChargeHeldByFreeze(
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
    summary: `${resolveDisplayName(roster, details["actorUnitId"])}は凍結のためチャージ「${details["skillDefinitionId"]}」を維持したまま待機しました。`,
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

export const skillEventFormatters: Readonly<Record<string, EventFormatter>> = {
  COOLDOWN_STARTED: formatCooldownStarted,
  COOLDOWN_REDUCED: formatCooldownReduced,
  COOLDOWN_COMPLETED: formatCooldownCompleted,
  CHARGE_STARTED: formatChargeStarted,
  CHARGE_RELEASED: formatChargeReleased,
  CHARGE_CANCELLED: formatChargeCancelled,
  CHARGE_HELD_BY_FREEZE: formatChargeHeldByFreeze,
  PASSIVE_ACTIVATED: formatPassiveActivated,
  PASSIVE_RESOLVED: formatPassiveResolved,
  PASSIVE_INTERRUPTED: formatPassiveInterrupted,
  PASSIVE_POINT_CONSUMED: formatPassivePointConsumed,
};
