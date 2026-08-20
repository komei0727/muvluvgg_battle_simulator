// docs/ui-design/01_UI要求・画面設計.md §8.6（`UI-AC-045`）/ 04_コンポーネント・状態管理設計.md
// `UI-CMP-027`: 効果インスタンス1件の一生（付与 → 消費 → 失効／解除）を、全イベント列から
// 取り出す純関数。componentはこの投影だけを描画する（`UI-CMP-005`）。
//
// この投影は**総称的**である。特定の`effectActionDefinitionId`に対する分岐を一切持たず、
// ログに現れた全インスタンスを同じ規則で扱う。どれを画面へ出すかは選択層（`focused-effects.ts`
// と`EffectTraceSection`）が決めるため、Catalogから追跡対象を自動列挙する将来の拡張でも
// この module は変わらない。
//
// APIの契約は変更していない。`DETAILED`ログが返すイベントのエンベロープと`details`だけを読む。

import { isRecord, numberOf, stringOf } from "../../lib/unknown-narrowing.js";
import type { BattleLogEventResponse } from "../simulation/api-contract.js";

/**
 * 効果インスタンスの終わり方。バーの色はこれで分ける。
 *
 * - `ONGOING`: 戦闘終了時点で保持されたまま。終端を持たない。
 * - `BREAK_REMOVED`: ブレイク復活に連動した解除（R-TEX-05 #2）。
 * - `CONSUMED`: 1回以上消費されて終わった（R-EFF-07）。
 * - `UNUSED_EXPIRED`: 消費条件を持ちながら1度も消費されずに終わった。調整で潰せるロスであり、
 *   この機能の主目的。
 * - `ENDED`: 消費条件を持たない効果の時間失効・特殊失効・明示解除。
 */
export type EffectTraceOutcome =
  | "ONGOING"
  | "BREAK_REMOVED"
  | "CONSUMED"
  | "UNUSED_EXPIRED"
  | "ENDED";

export interface EffectTraceConsumption {
  readonly sequence: number;
  readonly turnNumber: number;
  /** `EffectConsumptionChanged.kind`（`ConsumptionKind`）。 */
  readonly kind: string;
  readonly before: number;
  readonly after: number;
  /**
   * 消費を起こした側のユニット。`EffectConsumptionChanged`の`sourceUnitId`は**保持ユニット**
   * であり消費者ではないため、エンベロープを遡って求める。求まらない場合は`undefined`
   * （R-MEM-04のメモリー由来など、発生源がユニットでない経路）。
   */
  readonly consumerUnitId?: string;
}

export interface EffectTraceInstance {
  readonly effectInstanceId: string;
  readonly effectActionDefinitionId: string;
  /** 効果を保持するユニット。デバフは敵が保持し、消費者は味方になる。 */
  readonly holderUnitId: string;
  /** 付与元ユニット。メモリー由来の付与は持たない（R-MEM-04）。 */
  readonly originUnitId?: string;
  /** `originUnitId`が無い付与の発生陣営。`effect-event-formatters.ts`の`resolveOrigin`と同じ規約。 */
  readonly originSide?: string;
  readonly appliedSequence: number;
  readonly appliedTurnNumber: number;
  readonly consumptions: readonly EffectTraceConsumption[];
  readonly endedSequence?: number;
  readonly endedTurnNumber?: number;
  /** `EffectExpired.reason`／`EffectRemoved.reason`をそのまま運ぶ。 */
  readonly endReason?: string;
  readonly outcome: EffectTraceOutcome;
}

export interface EffectTraceView {
  /** 付与順（`sequence`昇順）。 */
  readonly instances: readonly EffectTraceInstance[];
  /** スイムレーンの列。イベントが観測された範囲を隙間なく並べる。 */
  readonly turnNumbers: readonly number[];
  /** ログに現れた効果の定義ID（昇順・重複なし）。選択層の一覧の元になる。 */
  readonly effectActionDefinitionIds: readonly string[];
}

interface MutableInstance {
  readonly effectInstanceId: string;
  readonly effectActionDefinitionId: string;
  readonly holderUnitId: string;
  readonly originUnitId?: string;
  readonly originSide?: string;
  readonly appliedSequence: number;
  readonly appliedTurnNumber: number;
  /**
   * 消費条件（`DurationDefinition.consumption`）を宣言した付与かどうか。「未消費で失効」を
   * 「そもそも消費条件を持たない効果の自然な終わり」と区別するために要る。
   */
  readonly hasConsumptionCondition: boolean;
  readonly consumptions: EffectTraceConsumption[];
  endedSequence?: number;
  endedTurnNumber?: number;
  endReason?: string;
  endEventType?: string;
  brokenAncestor?: boolean;
}

const GRANT_EVENT_TYPE = "EFFECT_APPLIED";
const CONSUMPTION_EVENT_TYPE = "EFFECT_CONSUMPTION_CHANGED";
const EXPIRY_EVENT_TYPE = "EFFECT_EXPIRED";
const REMOVAL_EVENT_TYPE = "EFFECT_REMOVED";
const BREAK_EVENT_TYPE = "UNIT_BROKEN";

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

/**
 * `parentSequence`を根へ向かって辿る。親が現在のイベント列に居ない（公開レベルで
 * 間引かれた等）場合はそこで打ち切る —— `event-causality-tree.ts`と同じく、欠番を
 * エラーにしない。同じsequenceを二度訪れないことで、壊れたログでも停止する。
 */
function* ancestorsOf(
  event: BattleLogEventResponse,
  eventBySequence: ReadonlyMap<number, BattleLogEventResponse>,
): Generator<BattleLogEventResponse> {
  const visited = new Set<number>([sequenceOf(event)]);
  let current = event;
  for (;;) {
    const parentSequence = numberOf(current["parentSequence"]);
    if (parentSequence === undefined || visited.has(parentSequence)) {
      return;
    }
    const parent = eventBySequence.get(parentSequence);
    if (parent === undefined) {
      return;
    }
    visited.add(parentSequence);
    yield parent;
    current = parent;
  }
}

/**
 * 消費を起こした側のユニットを求める。
 *
 * 1. 同じ`skillUseId`を持つ**先行**イベントのうち、最初に`sourceUnitId`を持つもの。1つの
 *    AS/PS/EX解決の起点（`SkillUseStarted`・`PassiveActivated`）が行動主体を名指しするため、
 *    ダメージ処理の途中で発行される消費イベントからでも攻撃側へ届く。
 * 2. `skillUseId`が無い経路では`parentSequence`の祖先を遡り、最初に`sourceUnitId`を持つもの。
 * 3. どちらも無ければ帰属不能（`undefined`）。R-MEM-04のメモリー由来のように`sourceSide`しか
 *    持たない発生源がこれにあたる。
 */
function resolveConsumerUnitId(
  event: BattleLogEventResponse,
  eventBySequence: ReadonlyMap<number, BattleLogEventResponse>,
  eventsBySkillUseId: ReadonlyMap<string, readonly BattleLogEventResponse[]>,
): string | undefined {
  const skillUseId = stringOf(event["skillUseId"]);
  if (skillUseId !== undefined) {
    const sequence = sequenceOf(event);
    for (const sibling of eventsBySkillUseId.get(skillUseId) ?? []) {
      if (sequenceOf(sibling) >= sequence) {
        break;
      }
      const sourceUnitId = stringOf(sibling["sourceUnitId"]);
      if (sourceUnitId !== undefined) {
        return sourceUnitId;
      }
    }
  }
  for (const ancestor of ancestorsOf(event, eventBySequence)) {
    const sourceUnitId = stringOf(ancestor["sourceUnitId"]);
    if (sourceUnitId !== undefined) {
      return sourceUnitId;
    }
  }
  return undefined;
}

/**
 * ブレイク復活による解除かどうか。`EffectRemovalReason`は`REMOVED`／`LINKED_GROUP_CASCADE`
 * しか持たず、ブレイク由来をreasonの語彙で名指しできない（`break-resolution-service.ts`）。
 * 解除は`UnitBroken`から**直列に**連なる（`linked-group-cascade.ts`は直前の解除を親にする）
 * ため、直接の親だけでは判定できず祖先を遡る。
 */
function hasBrokenAncestor(
  event: BattleLogEventResponse,
  eventBySequence: ReadonlyMap<number, BattleLogEventResponse>,
): boolean {
  for (const ancestor of ancestorsOf(event, eventBySequence)) {
    if (ancestor["type"] === BREAK_EVENT_TYPE) {
      return true;
    }
  }
  return false;
}

function outcomeOf(instance: MutableInstance): EffectTraceOutcome {
  if (instance.endedSequence === undefined) {
    return "ONGOING";
  }
  if (instance.endEventType === REMOVAL_EVENT_TYPE && instance.brokenAncestor === true) {
    return "BREAK_REMOVED";
  }
  if (instance.consumptions.length > 0) {
    return "CONSUMED";
  }
  return instance.hasConsumptionCondition ? "UNUSED_EXPIRED" : "ENDED";
}

function turnRangeOf(events: readonly BattleLogEventResponse[]): readonly number[] {
  if (events.length === 0) {
    return [];
  }
  const turnNumbers = events.map(turnNumberOf);
  // 戦闘開始前のイベントだけが`turnNumber: 0`を取り得る（`08_ドメインイベント.md`
  // エンベロープ）。列としては意味を持たないのでターン1から並べる。
  const first = Math.max(1, Math.min(...turnNumbers));
  const last = Math.max(...turnNumbers);
  if (last < first) {
    return [];
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

export function projectEffectTrace(events: readonly BattleLogEventResponse[]): EffectTraceView {
  const sorted = [...events].sort((a, b) => sequenceOf(a) - sequenceOf(b));
  const eventBySequence = new Map(sorted.map((event) => [sequenceOf(event), event] as const));
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

  const instances = new Map<string, MutableInstance>();

  for (const event of sorted) {
    const details = detailsOf(event);
    const effectInstanceId = stringOf(details["effectInstanceId"]);
    if (effectInstanceId === undefined) {
      continue;
    }

    if (event["type"] === GRANT_EVENT_TYPE) {
      const effectActionDefinitionId = stringOf(details["effectActionDefinitionId"]);
      const holderUnitId = stringOf(details["targetUnitId"]);
      if (effectActionDefinitionId === undefined || holderUnitId === undefined) {
        continue;
      }
      const originUnitId = stringOf(details["sourceUnitId"]) ?? stringOf(event["sourceUnitId"]);
      const originSide = stringOf(details["sourceSide"]) ?? stringOf(event["sourceSide"]);
      instances.set(effectInstanceId, {
        effectInstanceId,
        effectActionDefinitionId,
        holderUnitId,
        ...(originUnitId !== undefined ? { originUnitId } : {}),
        ...(originUnitId === undefined && originSide !== undefined ? { originSide } : {}),
        appliedSequence: sequenceOf(event),
        appliedTurnNumber: turnNumberOf(event),
        hasConsumptionCondition: stringOf(details["consumptionKind"]) !== undefined,
        consumptions: [],
      });
      continue;
    }

    // 付与を観測していないインスタンスの消費・失効は、そのインスタンスの一生を組み立て
    // られない（保持者も定義IDも消費イベントからは読めない）ため落とす。
    const instance = instances.get(effectInstanceId);
    if (instance === undefined) {
      continue;
    }

    if (event["type"] === CONSUMPTION_EVENT_TYPE) {
      const kind = stringOf(details["kind"]);
      const before = numberOf(details["before"]);
      const after = numberOf(details["after"]);
      if (kind === undefined || before === undefined || after === undefined) {
        continue;
      }
      const consumerUnitId = resolveConsumerUnitId(event, eventBySequence, eventsBySkillUseId);
      instance.consumptions.push({
        sequence: sequenceOf(event),
        turnNumber: turnNumberOf(event),
        kind,
        before,
        after,
        ...(consumerUnitId !== undefined ? { consumerUnitId } : {}),
      });
      continue;
    }

    const endEventType =
      event["type"] === EXPIRY_EVENT_TYPE || event["type"] === REMOVAL_EVENT_TYPE
        ? event["type"]
        : undefined;
    if (endEventType !== undefined) {
      const reason = stringOf(details["reason"]);
      instance.endedSequence = sequenceOf(event);
      instance.endedTurnNumber = turnNumberOf(event);
      instance.endEventType = endEventType;
      if (reason !== undefined) {
        instance.endReason = reason;
      }
      if (endEventType === REMOVAL_EVENT_TYPE) {
        instance.brokenAncestor = hasBrokenAncestor(event, eventBySequence);
      }
    }
  }

  const projected = [...instances.values()]
    .sort((a, b) => a.appliedSequence - b.appliedSequence)
    .map((instance) => ({
      effectInstanceId: instance.effectInstanceId,
      effectActionDefinitionId: instance.effectActionDefinitionId,
      holderUnitId: instance.holderUnitId,
      ...(instance.originUnitId !== undefined ? { originUnitId: instance.originUnitId } : {}),
      ...(instance.originSide !== undefined ? { originSide: instance.originSide } : {}),
      appliedSequence: instance.appliedSequence,
      appliedTurnNumber: instance.appliedTurnNumber,
      consumptions: [...instance.consumptions],
      ...(instance.endedSequence !== undefined ? { endedSequence: instance.endedSequence } : {}),
      ...(instance.endedTurnNumber !== undefined
        ? { endedTurnNumber: instance.endedTurnNumber }
        : {}),
      ...(instance.endReason !== undefined ? { endReason: instance.endReason } : {}),
      outcome: outcomeOf(instance),
    }));

  return {
    instances: projected,
    turnNumbers: turnRangeOf(sorted),
    effectActionDefinitionIds: [
      ...new Set(projected.map((instance) => instance.effectActionDefinitionId)),
    ].sort(),
  };
}
