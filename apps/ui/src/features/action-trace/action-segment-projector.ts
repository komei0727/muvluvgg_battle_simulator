// docs/ui-design/03_API・データ連携設計.md §12.5「区間」/ 01_UI要求・画面設計.md §8.10。
//
// イベント列を、行動トレースが1単位として進む・戻る「区間」の配列へ切り分ける純関数。
// 全イベントがちょうど1つの区間に属し、区間は`sequence`の昇順に並び範囲が重ならない
// （位置の索引がこの順序を前提にするため）。
//
// 行動中に割り込んだPSは、本番Catalogの戦闘ログでは割り込まれた行動と同じ`actionId`を
// 持つ。`actionId`を持たずに行動へ帰属させる必要があるのは、行動完了を親に持つ
// 行動予約の除去・行動順の並べ替え・編成の全滅のような後処理だけであり、これは
// `parentSequence`を遡って拾う。
import { isRecord, numberOf, stringOf } from "../../lib/unknown-narrowing.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

/** 陣営の解決に読む最小限のユニット。Roster・`unitRoster`・`initialState.units`をそのまま渡せる。 */
export interface SegmentSideSource {
  readonly battleUnitId: string;
  readonly side: string;
}

export interface SegmentMainSkill {
  readonly skillUseId: string;
  readonly skillDefinitionId?: string;
}

export type SystemSegmentHeadline =
  | { readonly kind: "BATTLE_STARTED" }
  | { readonly kind: "TURN_STARTED"; readonly turnNumber: number }
  | { readonly kind: "TURN_COMPLETED"; readonly turnNumber: number }
  | {
      readonly kind: "FORMATION_DEPLOYED";
      readonly side?: string;
      readonly formationNumber?: number;
    }
  | { readonly kind: "BATTLE_COMPLETED" }
  | { readonly kind: "OTHER" };

interface SegmentBase {
  /** 区間の配列の中の位置。 */
  readonly index: number;
  /** 先頭のイベントの`turnNumber`。 */
  readonly turnNumber: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  /** 先頭のイベントの`stateVersionBefore`。 */
  readonly stateVersionBefore: number;
  /** 区間内の`stateVersionAfter`の最大。 */
  readonly stateVersionAfter: number;
  readonly containsDefeat: boolean;
  /** 区間に属するイベント（sequence昇順）。 */
  readonly events: readonly BattleLogEventResponse[];
}

export interface ActionTraceSegment extends SegmentBase {
  readonly kind: "ACTION";
  readonly actionId: string;
  readonly actorUnitId?: string;
  /** 行動者の陣営。行動者がRosterに無ければ持たない。 */
  readonly side?: string;
  /** 行動本体のスキル解決（AS・EX・チャージ解放）。PSだけの行動では持たない。 */
  readonly mainSkill?: SegmentMainSkill;
  /** そのターンの行動区間の中での順番（1始まり）。 */
  readonly actionOrderInTurn: number;
}

export interface SystemTraceSegment extends SegmentBase {
  readonly kind: "SYSTEM";
  readonly headline: SystemSegmentHeadline;
}

export type ActionSegment = ActionTraceSegment | SystemTraceSegment;

const ACTIVATION_TYPES = new Set(["PASSIVE_ACTIVATED", "MEMORY_TRIGGERED"]);

function detailsOf(event: BattleLogEventResponse): Record<string, unknown> {
  const details = event["details"];
  return isRecord(details) ? details : {};
}

function sequenceOf(event: BattleLogEventResponse): number {
  return numberOf(event["sequence"]) ?? 0;
}

function turnNumberOf(event: BattleLogEventResponse): number {
  return numberOf(event["turnNumber"]) ?? 0;
}

function actorUnitIdOf(events: readonly BattleLogEventResponse[]): string | undefined {
  for (const event of events) {
    if (event.type === "ACTION_STARTED") {
      const actor = stringOf(detailsOf(event)["actorUnitId"]);
      if (actor !== undefined) {
        return actor;
      }
    }
  }
  for (const event of events) {
    const source = stringOf(event["sourceUnitId"]);
    if (source !== undefined) {
      return source;
    }
  }
  return undefined;
}

/**
 * 区間内で最初に現れる`skillUseId`のうち、そのイベント群にPS・メモリー発動を含まないもの。
 * スキル定義IDは起点typeで分岐せず、そのイベント群で最初に見つかった値を採る
 * （スキル時系列と同じ方針。コスト消費の有無でグループ内の順序が入れ替わり得るため）。
 */
function mainSkillOf(events: readonly BattleLogEventResponse[]): SegmentMainSkill | undefined {
  const groups = new Map<string, BattleLogEventResponse[]>();
  for (const event of events) {
    const skillUseId = stringOf(event["skillUseId"]);
    if (skillUseId === undefined) {
      continue;
    }
    const group = groups.get(skillUseId);
    if (group === undefined) {
      groups.set(skillUseId, [event]);
    } else {
      group.push(event);
    }
  }
  for (const [skillUseId, group] of groups) {
    if (group.some((event) => ACTIVATION_TYPES.has(event.type))) {
      continue;
    }
    const skillDefinitionId = group
      .map((event) => stringOf(detailsOf(event)["skillDefinitionId"]))
      .find((id) => id !== undefined);
    return { skillUseId, ...(skillDefinitionId !== undefined ? { skillDefinitionId } : {}) };
  }
  return undefined;
}

function headlineOf(events: readonly BattleLogEventResponse[]): SystemSegmentHeadline {
  for (const event of events) {
    switch (event.type) {
      case "BATTLE_STARTED":
        return { kind: "BATTLE_STARTED" };
      case "TURN_STARTED":
        return { kind: "TURN_STARTED", turnNumber: turnNumberOf(event) };
      case "TURN_COMPLETING":
      case "TURN_COMPLETED":
        return { kind: "TURN_COMPLETED", turnNumber: turnNumberOf(event) };
      case "FORMATION_DEPLOYED": {
        const details = detailsOf(event);
        const side = stringOf(details["side"]);
        const formationNumber = numberOf(details["formationNumber"]);
        return {
          kind: "FORMATION_DEPLOYED",
          ...(side !== undefined ? { side } : {}),
          ...(formationNumber !== undefined ? { formationNumber } : {}),
        };
      }
      case "BATTLE_COMPLETED":
        return { kind: "BATTLE_COMPLETED" };
      default:
        break;
    }
  }
  return { kind: "OTHER" };
}

interface PendingSegment {
  /** 行動区間なら`actionId`、システム区間なら`undefined`。 */
  readonly actionId: string | undefined;
  readonly events: BattleLogEventResponse[];
}

export function projectActionSegments(
  events: readonly BattleLogEventResponse[],
  roster: readonly SegmentSideSource[],
): readonly ActionSegment[] {
  const sorted = [...events].sort((a, b) => sequenceOf(a) - sequenceOf(b));
  const sideByUnitId = new Map(roster.map((unit) => [unit.battleUnitId, unit.side]));

  // 親は必ず子より小さいsequenceを持つため、昇順の1回の走査で祖先の帰属が決まっている。
  const actionIdBySequence = new Map<number, string | undefined>();
  const pending: PendingSegment[] = [];
  for (const event of sorted) {
    const parentSequence = numberOf(event["parentSequence"]);
    const actionId =
      stringOf(event["actionId"]) ??
      (parentSequence !== undefined ? actionIdBySequence.get(parentSequence) : undefined);
    actionIdBySequence.set(sequenceOf(event), actionId);

    const current = pending.at(-1);
    const continues =
      current !== undefined &&
      current.actionId === actionId &&
      (actionId !== undefined || turnNumberOf(current.events[0]!) === turnNumberOf(event));
    if (continues) {
      current.events.push(event);
    } else {
      pending.push({ actionId, events: [event] });
    }
  }

  const actionCountByTurn = new Map<number, number>();
  return pending.map((segment, index): ActionSegment => {
    const first = segment.events[0]!;
    const turnNumber = turnNumberOf(first);
    const base: SegmentBase = {
      index,
      turnNumber,
      firstSequence: sequenceOf(first),
      lastSequence: sequenceOf(segment.events.at(-1)!),
      stateVersionBefore: numberOf(first["stateVersionBefore"]) ?? 0,
      stateVersionAfter: Math.max(
        ...segment.events.map((event) => numberOf(event["stateVersionAfter"]) ?? 0),
      ),
      containsDefeat: segment.events.some((event) => event.type === "UNIT_DEFEATED"),
      events: segment.events,
    };
    if (segment.actionId === undefined) {
      return { ...base, kind: "SYSTEM", headline: headlineOf(segment.events) };
    }
    const actionOrderInTurn = (actionCountByTurn.get(turnNumber) ?? 0) + 1;
    actionCountByTurn.set(turnNumber, actionOrderInTurn);
    const actorUnitId = actorUnitIdOf(segment.events);
    const side = actorUnitId !== undefined ? sideByUnitId.get(actorUnitId) : undefined;
    const mainSkill = mainSkillOf(segment.events);
    return {
      ...base,
      kind: "ACTION",
      actionId: segment.actionId,
      actionOrderInTurn,
      ...(actorUnitId !== undefined ? { actorUnitId } : {}),
      ...(side !== undefined ? { side } : {}),
      ...(mainSkill !== undefined ? { mainSkill } : {}),
    };
  });
}
