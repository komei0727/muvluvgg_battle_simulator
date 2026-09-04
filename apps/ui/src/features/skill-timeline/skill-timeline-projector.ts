// docs/ui-design/01_UI要求・画面設計.md §8.8（`UI-AC-053`）/ 04_コンポーネント・状態管理設計.md
// `UI-CMP-036`: 1回のスキル発動（AS・PS・EX・チャージ解決・Memory発動）を、全イベント列から
// 取り出す純関数。componentはこの投影だけを描画する（`UI-CMP-005`）。
//
// この投影は**総称的**である。起点イベントのtypeで分岐せず、同じskillUseIdを持つイベント群を
// sequence昇順に走査して最初に見つかった値を採用する（`effect-trace-projector.ts`と同じ方針）。
// PASSIVE_POINT_CONSUMEDとPASSIVE_ACTIVATEDのように、コスト消費の有無でグループ内の
// イベント順序が入れ替わり得る経路があるため、「起点イベントのtypeで分岐する」設計は
// 順序変化に弱く採用しない。
import { isRecord, numberOf, stringOf } from "../../lib/unknown-narrowing.js";
import type { BattleLogEventResponse } from "../../shared/api/api-contract.js";

export type SkillActivationOutcome = "COMPLETED" | "INTERRUPTED" | "IN_PROGRESS";

export interface SkillActivationInstance {
  readonly skillUseId: string;
  /** Memory由来（R-MEM-04相当）の発動は特定ユニットに属さないため持たない。 */
  readonly actorUnitId?: string;
  /** `actorUnitId`が無い発動の発生陣営。`effect-trace-projector.ts`の`originSide`と同じ規約。 */
  readonly actorSide?: string;
  readonly skillDefinitionId: string;
  readonly startSequence: number;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  /** このskillUseIdに属する全イベント（sequence昇順）。因果ツリー表示へそのまま渡す。 */
  readonly events: readonly BattleLogEventResponse[];
  readonly outcome: SkillActivationOutcome;
  readonly endedSequence?: number;
}

export interface SkillTimelineView {
  /** startSequence昇順。 */
  readonly instances: readonly SkillActivationInstance[];
  /** フィルタ「ユニット」用一覧（初出順・重複なし）。 */
  readonly actorUnitIds: readonly string[];
  /** actorUnitIdを持たない発動の発生陣営一覧（Memory由来がある場合のみ非空）。 */
  readonly actorSides: readonly string[];
  /** フィルタ「スキル」用一覧（昇順・重複なし）。 */
  readonly skillDefinitionIds: readonly string[];
}

const COMPLETION_EVENT_TYPES = new Set([
  "SKILL_USE_COMPLETED",
  "PASSIVE_RESOLVED",
  "MEMORY_RESOLVED",
]);
const INTERRUPTION_EVENT_TYPES = new Set(["SKILL_USE_INTERRUPTED", "PASSIVE_INTERRUPTED"]);

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

function cycleNumberOf(event: BattleLogEventResponse): number {
  return numberOf(event["cycleNumber"]) ?? 0;
}

/** グループをsequence昇順に走査し、最初に見つかった`skillDefinitionId`（無ければ`memoryDefinitionId`）を返す。 */
function skillDefinitionIdOf(events: readonly BattleLogEventResponse[]): string | undefined {
  for (const event of events) {
    const details = detailsOf(event);
    const found = stringOf(details["skillDefinitionId"]) ?? stringOf(details["memoryDefinitionId"]);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** グループをsequence昇順に走査し、最初に見つかった`actorUnitId`を返す。 */
function actorUnitIdOf(events: readonly BattleLogEventResponse[]): string | undefined {
  for (const event of events) {
    const found = stringOf(detailsOf(event)["actorUnitId"]) ?? stringOf(event["sourceUnitId"]);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** `actorUnitId`が求まらない発動（Memory由来）だけが使う、発生陣営の解決。 */
function actorSideOf(events: readonly BattleLogEventResponse[]): string | undefined {
  for (const event of events) {
    const found = stringOf(event["sourceSide"]) ?? stringOf(detailsOf(event)["sourceSide"]);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function outcomeOf(events: readonly BattleLogEventResponse[]): {
  readonly outcome: SkillActivationOutcome;
  readonly endedSequence?: number;
} {
  for (const event of events) {
    const type = event["type"];
    if (typeof type === "string" && COMPLETION_EVENT_TYPES.has(type)) {
      return { outcome: "COMPLETED", endedSequence: sequenceOf(event) };
    }
    if (typeof type === "string" && INTERRUPTION_EVENT_TYPES.has(type)) {
      return { outcome: "INTERRUPTED", endedSequence: sequenceOf(event) };
    }
  }
  return { outcome: "IN_PROGRESS" };
}

export function projectSkillTimeline(events: readonly BattleLogEventResponse[]): SkillTimelineView {
  const sorted = [...events].sort((a, b) => sequenceOf(a) - sequenceOf(b));

  const eventsBySkillUseId = new Map<string, BattleLogEventResponse[]>();
  for (const event of sorted) {
    const skillUseId = stringOf(event["skillUseId"]);
    if (skillUseId === undefined) {
      continue;
    }
    const siblings = eventsBySkillUseId.get(skillUseId);
    if (siblings === undefined) {
      eventsBySkillUseId.set(skillUseId, [event]);
    } else {
      siblings.push(event);
    }
  }

  const instances: SkillActivationInstance[] = [];
  for (const [skillUseId, groupEvents] of eventsBySkillUseId) {
    const skillDefinitionId = skillDefinitionIdOf(groupEvents);
    if (skillDefinitionId === undefined) {
      continue;
    }
    const actorUnitId = actorUnitIdOf(groupEvents);
    const actorSide = actorUnitId === undefined ? actorSideOf(groupEvents) : undefined;
    const startEvent = groupEvents[0]!;
    const { outcome, endedSequence } = outcomeOf(groupEvents);

    instances.push({
      skillUseId,
      ...(actorUnitId !== undefined ? { actorUnitId } : {}),
      ...(actorSide !== undefined ? { actorSide } : {}),
      skillDefinitionId,
      startSequence: sequenceOf(startEvent),
      turnNumber: turnNumberOf(startEvent),
      cycleNumber: cycleNumberOf(startEvent),
      events: groupEvents,
      outcome,
      ...(endedSequence !== undefined ? { endedSequence } : {}),
    });
  }

  instances.sort((a, b) => a.startSequence - b.startSequence);

  const actorUnitIds: string[] = [];
  const seenActorUnitIds = new Set<string>();
  const actorSides = new Set<string>();
  for (const instance of instances) {
    if (instance.actorUnitId !== undefined && !seenActorUnitIds.has(instance.actorUnitId)) {
      seenActorUnitIds.add(instance.actorUnitId);
      actorUnitIds.push(instance.actorUnitId);
    }
    if (instance.actorSide !== undefined) {
      actorSides.add(instance.actorSide);
    }
  }

  return {
    instances,
    actorUnitIds,
    actorSides: [...actorSides].sort(),
    skillDefinitionIds: [
      ...new Set(instances.map((instance) => instance.skillDefinitionId)),
    ].sort(),
  };
}
