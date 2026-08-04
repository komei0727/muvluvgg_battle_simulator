// M7-009（Issue #182）: docs/ui-design/07_UI実装・拡張計画.md §11「M7 効果・状態異常・
// 回復拡張」。回復・効果ライフサイクル・状態異常・命中判定のイベント。共通の型・helperは
// `event-presentation.ts`が持つ（formatter群の各ファイル間で循環importを避けるため）。

import { resolveDisplayName } from "./event-presentation.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

// 付与元はユニット(sourceUnitId)か陣営(sourceSide、R-MEM-04のMemory由来)の
// どちらかであり、どちらも無いイベントは詳細側で"-"表示にする。
function resolveOrigin(
  event: BattleLogEventResponse,
  details: Record<string, unknown>,
  roster: RosterIndex,
): string {
  const sourceUnitId = details["sourceUnitId"] ?? event["sourceUnitId"];
  if (typeof sourceUnitId === "string") {
    return resolveDisplayName(roster, sourceUnitId);
  }
  const sourceSide = details["sourceSide"] ?? event["sourceSide"];
  return typeof sourceSide === "string" ? `${sourceSide}陣営のMemory` : "-";
}

/** `EffectApplied.details.durationUnit`/`initialRemaining`（両方持つ場合だけ期間を表示する）。 */
function durationText(details: Record<string, unknown>): string {
  const durationUnit = details["durationUnit"];
  const initialRemaining = details["initialRemaining"];
  if (typeof durationUnit !== "string" || typeof initialRemaining !== "number") {
    return "";
  }
  return `、期間 ${durationUnit} ${initialRemaining}`;
}

// R-HEAL-01〜03（M7-005、Issue #184）: 表示するのは要求量(`healAmount`)ではなく
// 実際に増えたHP量(`appliedAmount`)。破棄したoverheal分は別に添える。
function formatHealApplied(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["appliedAmount"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  const discardedAmount = details["discardedAmount"];
  const discardedText =
    typeof discardedAmount === "number" && discardedAmount > 0
      ? `（超過${discardedAmount}を破棄）`
      : "";
  return {
    title: event.type,
    summary: `${resolveOrigin(event, details, roster)} → ${resolveDisplayName(roster, details["targetUnitId"])}のHPを${details["appliedAmount"]}回復しました${discardedText}。HP ${details["hpBefore"]} → ${details["hpAfter"]}`,
    details,
    severity: "positive",
  };
}

// R-HEAL-04（M7-005-HEAL-LINK、Issue #229）: 回復リンクによる転送。
//
// 転送先の最大HP超過分（`discardedAmount`）を落とすと、割当済みの回復が破棄された
// 事実を追跡できない。特に「連鎖の途中で転送先が戦闘不能になり、`appliedAmount: 0`／
// `discardedAmount: 転送量全量`の監査証跡として発行された」場合（R-HEAL-04の中断規約）、
// `appliedAmount`だけを表示すると「HPを0回復しました」としか読めなくなる。全量破棄は
// HPが増えていないので`positive`にもしない。
function formatHealingTransferred(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["fromUnitId"] !== "string" ||
    typeof details["toUnitId"] !== "string" ||
    typeof details["appliedAmount"] !== "number" ||
    typeof details["hpBefore"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  const appliedAmount = details["appliedAmount"];
  const discardedAmount = details["discardedAmount"];
  const discardedText =
    typeof discardedAmount === "number" && discardedAmount > 0
      ? `（転送分のうち${discardedAmount}を破棄）`
      : "";
  const fromName = resolveDisplayName(roster, details["fromUnitId"]);
  const toName = resolveDisplayName(roster, details["toUnitId"]);
  if (appliedAmount === 0) {
    return {
      title: event.type,
      summary: `${fromName}への回復が${toName}へ転送されましたが、HPは増えませんでした${discardedText}。HP ${details["hpBefore"]} → ${details["hpAfter"]}`,
      details,
      severity: "neutral",
    };
  }
  return {
    title: event.type,
    summary: `${fromName}への回復が${toName}へ転送され、HPを${appliedAmount}回復しました${discardedText}。HP ${details["hpBefore"]} → ${details["hpAfter"]}`,
    details,
    severity: "positive",
  };
}

// R-EFF-01/05（EFF-001〜002）: 付与。`statusKind`を持つ付与（`APPLY_STATUS`由来）は
// 種別をそのまま表示し、定義IDの命名規則から推測しない。
//
// `statusKind`は気絶・凍結・暗闇（`STATUS_AILMENT_KINDS`）だけでなくSTEALTH・
// EVASION・DAMAGE_IMMUNITY等の有利な状態にも設定される。R-STS-01のどちらに当たるかは
// Domainの`effect-category-classifier.ts`が正本であり、`EffectApplied`のdetailsは
// その分類（`category`）を持たない。UI側で状態異常の部分集合を持つとDomainの規則が
// 二重定義になり黙って乖離するため、時系列イベントでは「状態」と中立に表示し、
// severityも中立に保つ。バフ／デバフ／状態異常の分類は`EffectStateResponse.category`を
// 持つ「ユニット状態」タブ側で表示する。
function formatEffectApplied(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["kindKey"] !== "string" ||
    typeof details["duplicate"] !== "boolean"
  ) {
    return undefined;
  }
  const statusKind = details["statusKind"];
  const statusText = typeof statusKind === "string" ? `状態 ${statusKind}（` : "効果「";
  const statusTextEnd = typeof statusKind === "string" ? "）" : "」";
  const duplicateText = details["duplicate"] ? "、重複あり" : "";
  return {
    title: event.type,
    summary: `${resolveOrigin(event, details, roster)} → ${resolveDisplayName(roster, details["targetUnitId"])}へ${statusText}${details["kindKey"]}${statusTextEnd}を付与しました${durationText(details)}${duplicateText}。`,
    details,
    severity: "neutral",
  };
}

// R-EFF-03（M7-001B、Issue #243）: 免疫が新規付与を拒否した事実。
function formatEffectApplicationRejected(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["effectActionDefinitionId"] !== "string" ||
    typeof details["blockingEffectInstanceId"] !== "string" ||
    typeof details["reason"] !== "string"
  ) {
    return undefined;
  }
  // `formatEffectApplied`と同じ理由で、状態異常かどうかをUI側で判定せず種別だけを添える。
  const statusKind = details["statusKind"];
  const statusText = typeof statusKind === "string" ? `（状態 ${statusKind}）` : "";
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}への効果「${details["effectActionDefinitionId"]}」${statusText}の付与が拒否されました（理由: ${details["reason"]}、拒否した効果: ${details["blockingEffectInstanceId"]}）。`,
    details,
    severity: "neutral",
  };
}

/** `EffectExpired`（失効、R-EFF-04/06/07/08/09）と`EffectRemoved`（解除、R-EFF-02/09）は同じ形。 */
function effectLifecycleEndFormatter(verb: string): EventFormatter {
  return (event, roster) => {
    const details = event["details"];
    if (
      !isRecord(details) ||
      typeof details["battleUnitId"] !== "string" ||
      typeof details["kindKey"] !== "string" ||
      typeof details["reason"] !== "string" ||
      typeof details["cascaded"] !== "boolean"
    ) {
      return undefined;
    }
    const cascadedText = details["cascaded"] ? "、連動グループの連鎖" : "";
    return {
      title: event.type,
      summary: `${resolveDisplayName(roster, details["battleUnitId"])}の効果「${details["kindKey"]}」が${verb}しました（理由: ${details["reason"]}${cascadedText}）。`,
      details,
      severity: "neutral",
    };
  };
}

/** `EffectDurationReduced`（R-EFF-04/06）と`EffectConsumptionChanged`（R-EFF-07）の残り回数変化。 */
function effectRemainingChangeFormatter(label: string, unitKey: string): EventFormatter {
  return (event, roster) => {
    const details = event["details"];
    if (
      !isRecord(details) ||
      typeof details["battleUnitId"] !== "string" ||
      typeof details["effectInstanceId"] !== "string" ||
      typeof details[unitKey] !== "string" ||
      typeof details["before"] !== "number" ||
      typeof details["after"] !== "number"
    ) {
      return undefined;
    }
    return {
      title: event.type,
      summary: `${resolveDisplayName(roster, details["battleUnitId"])}の効果「${details["effectInstanceId"]}」の${label}（${String(details[unitKey])}）が${details["before"]} → ${details["after"]}になりました。`,
      details,
      severity: "neutral",
    };
  };
}

// R-EFF-05: 同種グループで採用中のインスタンスが入れ替わった。before/afterは
// グループに1件も採用中が無い場合だけ欠ける（その場合は「なし」と表示する）。
function formatEffectiveEffectChanged(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["kindKey"] !== "string"
  ) {
    return undefined;
  }
  const before = typeof details["before"] === "string" ? details["before"] : "なし";
  const after = typeof details["after"] === "string" ? details["after"] : "なし";
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の効果種別「${details["kindKey"]}」で採用中の効果が${before} → ${after}になりました。`,
    details,
    severity: "neutral",
  };
}

// R-STA-04: 効果の付与・失効・解除で実効ステータスが変化した。
function formatCombatStatChanged(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["stat"] !== "string" ||
    typeof details["before"] !== "number" ||
    typeof details["after"] !== "number" ||
    typeof details["reason"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の${details["stat"]}が${details["before"]} → ${details["after"]}になりました（理由: ${details["reason"]}）。`,
    details,
    severity: "neutral",
  };
}

// R-STS-02（Issue #180）: より長い残り回数の気絶が再付与され差し替わった。
function formatStunDurationChanged(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["remainingBefore"] !== "number" ||
    typeof details["remainingAfter"] !== "number" ||
    typeof details["reason"] !== "string"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の気絶の残り回数が${details["remainingBefore"]} → ${details["remainingAfter"]}になりました（理由: ${details["reason"]}）。`,
    details,
    severity: "negative",
  };
}

// R-STS-03（Issue #183）: 凍結中の対象へダメージのヒットが確定し凍結が解除された。
function formatFreezeRemoved(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["battleUnitId"] !== "string" ||
    typeof details["triggeringDamage"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["battleUnitId"])}の凍結がダメージ${details["triggeringDamage"]}で解除されました。`,
    details,
    severity: "neutral",
  };
}

// R-HIT-03（Issue #183）: 暗闇1件ごとのMISS判定。
function formatBlindnessCheckResolved(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["probability"] !== "number" ||
    typeof details["missed"] !== "boolean"
  ) {
    return undefined;
  }
  const sourceUnitId = event["sourceUnitId"];
  const actorName =
    typeof sourceUnitId === "string" ? resolveDisplayName(roster, sourceUnitId) : "-";
  return {
    title: event.type,
    summary: `${actorName}の暗闇判定（確率${details["probability"]}）は${details["missed"] ? "MISS" : "命中"}でした。`,
    details,
    severity: details["missed"] ? "negative" : "neutral",
  };
}

// R-HIT-03: 暗闇判定でスキル全体がMISSになった。
function formatSkillMissed(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["skillDefinitionId"] !== "string" ||
    !Array.isArray(details["missedByEffectInstanceIds"])
  ) {
    return undefined;
  }
  const sourceUnitId = event["sourceUnitId"];
  const actorName =
    typeof sourceUnitId === "string" ? resolveDisplayName(roster, sourceUnitId) : "-";
  return {
    title: event.type,
    summary: `${actorName}のスキル「${details["skillDefinitionId"]}」が暗闇によりMISSしました（${details["missedByEffectInstanceIds"].length}件の暗闇）。`,
    details,
    severity: "negative",
  };
}

// R-STS-04（Issue #183）: 回避が成立しヒットが無効化された。
function formatEvasionActivated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (!isRecord(details) || typeof details["targetUnitId"] !== "string") {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["targetUnitId"])}が回避しました。`,
    details,
    severity: "neutral",
  };
}

export const effectEventFormatters: Readonly<Record<string, EventFormatter>> = {
  HEAL_APPLIED: formatHealApplied,
  HEALING_TRANSFERRED: formatHealingTransferred,
  EFFECT_APPLIED: formatEffectApplied,
  EFFECT_APPLICATION_REJECTED: formatEffectApplicationRejected,
  EFFECT_EXPIRED: effectLifecycleEndFormatter("失効"),
  EFFECT_REMOVED: effectLifecycleEndFormatter("解除"),
  EFFECT_DURATION_REDUCED: effectRemainingChangeFormatter("残り回数", "unit"),
  EFFECT_CONSUMPTION_CHANGED: effectRemainingChangeFormatter("消費残り回数", "kind"),
  EFFECTIVE_EFFECT_CHANGED: formatEffectiveEffectChanged,
  COMBAT_STAT_CHANGED: formatCombatStatChanged,
  STUN_DURATION_CHANGED: formatStunDurationChanged,
  FREEZE_REMOVED: formatFreezeRemoved,
  BLINDNESS_CHECK_RESOLVED: formatBlindnessCheckResolved,
  SKILL_MISSED: formatSkillMissed,
  EVASION_ACTIVATED: formatEvasionActivated,
};
