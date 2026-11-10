// docs/ui-design/03_API・データ連携設計.md §12「イベント表示」のうち、スキルの
// クールタイム・チャージ・パッシブのライフサイクルを表すイベント。共通の型・helperは
// `event-presentation.ts`が持つ（formatter群の各ファイル間で循環importを避けるため）。
import { labelerFor } from "./event-presentation.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";
import type { EffectLabeler } from "../../lib/effect-display-label.js";

function formatCooldownStarted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
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
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `スキル「${skill}」のクールタイムを設定しました（残り${details["initialRemaining"]}）。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

function formatCooldownReduced(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
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
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `スキル「${skill}」のクールタイムが${details["before"]} → ${details["after"]}になりました。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

function formatCooldownCompleted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `スキル「${skill}」のクールタイムが完了しました。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

function formatChargeStarted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `スキル「${skill}」のチャージを開始しました。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

function formatChargeReleased(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `チャージ「${skill}」が発動しました。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

// R-SKL-05/R-STS-03（Issue #180）: 凍結・気絶とチャージの相互作用。
function formatChargeCancelled(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
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
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `チャージ「${skill}」が中断されました（理由: ${details["reason"]}）。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "negative",
  };
}

function formatChargeHeldByFreeze(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["actorUnitId"] !== "string" ||
    typeof details["skillDefinitionId"] !== "string"
  ) {
    return undefined;
  }
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `凍結のためチャージ「${skill}」を維持したまま待機しました。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

function formatPassiveActivated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
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
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `パッシブスキル「${skill}」が発動しました。PP ${details["ppBefore"]} → ${details["ppAfter"]} / EX ${details["exBefore"]} → ${details["exAfter"]}`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

function formatPassiveResolved(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
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
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `パッシブスキル「${skill}」の効果解決が完了しました（${details["resolvedStepCount"]}step）。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "neutral",
  };
}

function formatPassiveInterrupted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
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
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `パッシブスキル「${skill}」が中断しました（理由: ${details["reason"]}、未解決効果${details["unresolvedEffectCount"]}件）。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
    severity: "negative",
  };
}

function formatPassivePointConsumed(
  event: BattleLogEventResponse,
  roster: RosterIndex,
  labeler?: EffectLabeler,
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
  const skill = labelerFor(roster, labeler).skillLabel(
    details["actorUnitId"],
    details["skillDefinitionId"],
  );
  return {
    title: event.type,
    summary: `パッシブスキル「${skill}」がPPを消費しました。PP ${details["before"]} → ${details["after"]}（消費${details["consumedAmount"]}）。`,
    details,
    logicalNames: [details["skillDefinitionId"]],
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
