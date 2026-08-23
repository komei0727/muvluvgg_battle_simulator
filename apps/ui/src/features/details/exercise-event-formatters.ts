// docs/ui-design/03_API・データ連携設計.md §12「イベント表示」のうち、戦術演習
// （`R-TEX-02`〜`R-TEX-05`）でだけ現れるイベント。共通の型・helperは
// `event-presentation.ts`が持つ（formatter群の各ファイル間で循環importを避けるため）。
//
// `UI-API-016`: 演習イベントも未知イベントと同じ許容規則で扱う。detailsが想定
// shapeでなければ`undefined`を返し、`formatEvent`のgeneric fallbackへ落とす。
import { resolveDisplayName } from "./event-presentation.js";
import { isRecord } from "../../lib/unknown-narrowing.js";
import type { EventFormatter, EventPresentation, RosterIndex } from "./event-presentation.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

function formatExerciseScoreAccumulated(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["amount"] !== "number" ||
    typeof details["totalScore"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["targetUnitId"])}へのダメージでスコアが${details["amount"].toLocaleString()}加算されました（累計 ${details["totalScore"].toLocaleString()}）。`,
    details,
    severity: "positive",
  };
}

function formatExerciseScoreDeducted(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["targetUnitId"] !== "string" ||
    typeof details["amount"] !== "number" ||
    typeof details["totalScore"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["targetUnitId"])}の回復でスコアが${details["amount"].toLocaleString()}減算されました（累計 ${details["totalScore"].toLocaleString()}）。`,
    details,
    // 敵のHPが戻った＝敵に有利な事象であり、`UNIT_REVIVED`と同じ扱いにする。
    severity: "negative",
  };
}

function formatUnitBroken(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["unitId"] !== "string" ||
    typeof details["breakNumber"] !== "number" ||
    typeof details["turnNumber"] !== "number" ||
    typeof details["totalScore"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["unitId"])}をブレイクしました（${details["breakNumber"]}回目、ターン${details["turnNumber"]}、累計スコア ${details["totalScore"].toLocaleString()}）。`,
    details,
    severity: "positive",
  };
}

function formatUnitRevived(
  event: BattleLogEventResponse,
  roster: RosterIndex,
): EventPresentation | undefined {
  const details = event["details"];
  if (
    !isRecord(details) ||
    typeof details["unitId"] !== "string" ||
    typeof details["breakNumber"] !== "number" ||
    typeof details["hpAfter"] !== "number"
  ) {
    return undefined;
  }
  return {
    title: event.type,
    summary: `${resolveDisplayName(roster, details["unitId"])}が強化されて復活しました（${details["breakNumber"]}回目のブレイク後、HP ${details["hpAfter"].toLocaleString()}）。`,
    details,
    severity: "negative",
  };
}

export const exerciseEventFormatters: Readonly<Record<string, EventFormatter>> = {
  EXERCISE_SCORE_ACCUMULATED: formatExerciseScoreAccumulated,
  EXERCISE_SCORE_DEDUCTED: formatExerciseScoreDeducted,
  UNIT_BROKEN: formatUnitBroken,
  UNIT_REVIVED: formatUnitRevived,
};
