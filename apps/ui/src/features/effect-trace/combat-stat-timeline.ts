// docs/ui-design/01_UI要求・画面設計.md §8.7（`UI-AC-046`）: 任意の`sequence`時点での
// 実効ステータスを復元する純関数。順位セレクタが「解決時点の実効値」で対象を選ぶため、
// 開始時ステータスの順位では代用できない（割合バフ1つがギア数十枚分を動かす）。
//
// **値の出所は`stateTransitions`であって`COMBAT_STAT_CHANGED`のdetailsではない。**
// R-NUM-01によりDomainは割合を`1.0 = 100%`で持ち、公開境界の`CombatStatsResponse`だけが
// パーセントポイントへ直す。`stateTransitions`の差分は同じ変換を通っている
// （`simulate-battle-response-mapper.ts`の`PERCENTAGE_POINT_COMBAT_STATS`。
// 「差分側も同じ単位で出さないとクライアントは`ValueChange.before`を現在値と
// 突き合わせられない」という契約）が、イベントの`details.before`/`after`は通っていない
// —— 実応答では同じ会心率が`initialState`で`20`、`COMBAT_STAT_CHANGED`で`0.2`になる。
// イベント側を折り畳むと桁違いの値になるため、値は差分から取り、イベントは
// 「その変化がどの効果によるものか」の帰属にだけ使う。
//
// 状態全体は復元しない（`delta-flattener.ts`／`StateTransitionTable`の担当）。ここが持つのは
// 必要なステータスの系列だけである。

import { isRecord, numberOf, stringOf } from "../../lib/unknown-narrowing.js";
import type { BattleLogEventResponse, BattleLogResponse } from "../simulation/api-contract.js";

/**
 * `CombatStatsResponse`のフィールド名。`maximumHp`だけは公開レスポンス上の置き場所が
 * `combatStats`ではなく`hp.maximum`／差分の`hpMaximum`である。
 */
export type CombatStatField =
  | "attack"
  | "defense"
  | "criticalRate"
  | "actionSpeed"
  | "affinityBonus"
  | "criticalDamageBonus"
  | "maximumHp";

/** 開始時の値からの純増減を、それを起こした効果（または帰属できない場合は理由）ごとに分けたもの。 */
export type CombatStatContribution =
  | { readonly effectActionDefinitionId: string; readonly amount: number }
  | { readonly reason: string; readonly amount: number };

export interface CombatStatTimeline {
  /**
   * `sequence`**より前**の変化だけを畳んだ実効値。順位セレクタは対象の決定を付与より前に
   * 済ませているため、付与イベント自身が起こした変化を含めてはならない。
   * 初期値が読めない、または系列が信頼できない場合は`undefined`。
   */
  valueBefore(battleUnitId: string, field: CombatStatField, sequence: number): number | undefined;
  /** 開始時（`initialState`）の値。 */
  initialValue(battleUnitId: string, field: CombatStatField): number | undefined;
  /** 開始時からその時点までの内訳。打ち消しあって0になった効果は含めない。 */
  contributionsBefore(
    battleUnitId: string,
    field: CombatStatField,
    sequence: number,
  ): readonly CombatStatContribution[];
}

const HP_MAXIMUM_FIELD: CombatStatField = "maximumHp";

/** 浮動小数の丸め誤差（実応答に`27957.300000000003`のような値が出る）を跨いで比較する。 */
const EPSILON = 1e-6;

interface AppliedChange {
  readonly sequence: number;
  readonly amount: number;
  readonly effectActionDefinitionId?: string;
  readonly reason?: string;
}

interface Series {
  readonly initialValue: number | undefined;
  /** `sequence`昇順。 */
  readonly changes: AppliedChange[];
  /**
   * 差分の`before`が手元の値と食い違った位置。ここ以降の値は信用できない。
   * 値を出さない代わりに、黙って誤った数値を出すことを避ける。
   */
  brokenFromSequence?: number;
}

const EFFECT_LIFECYCLE_TYPES: ReadonlySet<string> = new Set([
  "EFFECT_APPLIED",
  "EFFECT_EXPIRED",
  "EFFECT_REMOVED",
]);

function seriesKey(battleUnitId: string, field: CombatStatField): string {
  return `${battleUnitId}|${field}`;
}

/**
 * `COMBAT_STAT_CHANGED`を起こした効果を、`parentSequence`の祖先を遡って求める。実応答では
 * この経路で全件（124/124）が効果へ帰属した。`effect-trace-projector.ts`の祖先探索と同じ
 * 規約で、親が居ない場合はそこで打ち切る。
 */
function resolveCausingEffect(
  event: BattleLogEventResponse,
  eventBySequence: ReadonlyMap<number, BattleLogEventResponse>,
): string | undefined {
  const visited = new Set<number>([numberOf(event["sequence"]) ?? 0]);
  let current = event;
  for (;;) {
    const parentSequence = numberOf(current["parentSequence"]);
    if (parentSequence === undefined || visited.has(parentSequence)) {
      return undefined;
    }
    const parent = eventBySequence.get(parentSequence);
    if (parent === undefined) {
      return undefined;
    }
    visited.add(parentSequence);
    const type = stringOf(parent["type"]);
    if (type !== undefined && EFFECT_LIFECYCLE_TYPES.has(type)) {
      const details = parent["details"];
      return isRecord(details) ? stringOf(details["effectActionDefinitionId"]) : undefined;
    }
    current = parent;
  }
}

/** 1つの状態遷移が運ぶ、ユニット×フィールドごとの前後値。 */
interface DeltaEntry {
  readonly battleUnitId: string;
  readonly field: CombatStatField;
  readonly before: number;
  readonly after: number;
}

function readDeltaEntries(transition: unknown): readonly DeltaEntry[] {
  if (!isRecord(transition)) {
    return [];
  }
  const delta = transition["delta"];
  if (!isRecord(delta)) {
    return [];
  }
  const units = delta["units"];
  if (!isRecord(units)) {
    return [];
  }
  const entries: DeltaEntry[] = [];
  for (const [battleUnitId, unitDelta] of Object.entries(units)) {
    if (!isRecord(unitDelta)) {
      continue;
    }
    const combatStats = unitDelta["combatStats"];
    if (isRecord(combatStats)) {
      for (const [field, change] of Object.entries(combatStats)) {
        if (!isRecord(change)) {
          continue;
        }
        const before = numberOf(change["before"]);
        const after = numberOf(change["after"]);
        if (before !== undefined && after !== undefined) {
          entries.push({ battleUnitId, field: field as CombatStatField, before, after });
        }
      }
    }
    const hpMaximum = unitDelta["hpMaximum"];
    if (isRecord(hpMaximum)) {
      const before = numberOf(hpMaximum["before"]);
      const after = numberOf(hpMaximum["after"]);
      if (before !== undefined && after !== undefined) {
        entries.push({ battleUnitId, field: HP_MAXIMUM_FIELD, before, after });
      }
    }
  }
  return entries;
}

function readInitialSeries(response: BattleLogResponse): Map<string, Series> {
  const series = new Map<string, Series>();
  for (const unit of response.initialState.units) {
    const battleUnitId = stringOf(unit["battleUnitId"]);
    if (battleUnitId === undefined) {
      continue;
    }
    const combatStats = unit["combatStats"];
    if (isRecord(combatStats)) {
      for (const [field, value] of Object.entries(combatStats)) {
        const initialValue = numberOf(value);
        if (initialValue !== undefined) {
          series.set(seriesKey(battleUnitId, field as CombatStatField), {
            initialValue,
            changes: [],
          });
        }
      }
    }
    const hp = unit["hp"];
    if (isRecord(hp)) {
      const maximum = numberOf(hp["maximum"]);
      if (maximum !== undefined) {
        series.set(seriesKey(battleUnitId, HP_MAXIMUM_FIELD), {
          initialValue: maximum,
          changes: [],
        });
      }
    }
  }
  return series;
}

export function buildCombatStatTimeline(response: BattleLogResponse): CombatStatTimeline {
  const series = readInitialSeries(response);

  const eventBySequence = new Map<number, BattleLogEventResponse>();
  for (const event of response.events) {
    const sequence = numberOf(event["sequence"]);
    if (sequence !== undefined) {
      eventBySequence.set(sequence, event);
    }
  }

  const sortedTransitions = [...response.stateTransitions].sort(
    (a, b) => (numberOf(a["causedBySequence"]) ?? 0) - (numberOf(b["causedBySequence"]) ?? 0),
  );

  // 手元の折り畳み値。`before`との突き合わせに使う。
  const running = new Map<string, number>();
  for (const [key, entry] of series) {
    if (entry.initialValue !== undefined) {
      running.set(key, entry.initialValue);
    }
  }

  for (const transition of sortedTransitions) {
    const causedBySequence = numberOf(transition["causedBySequence"]);
    if (causedBySequence === undefined) {
      continue;
    }
    const causingEvent = eventBySequence.get(causedBySequence);
    for (const entry of readDeltaEntries(transition)) {
      const key = seriesKey(entry.battleUnitId, entry.field);
      const found = series.get(key);
      if (found === undefined || found.brokenFromSequence !== undefined) {
        continue;
      }
      const current = running.get(key);
      if (current === undefined || Math.abs(current - entry.before) > EPSILON) {
        found.brokenFromSequence = causedBySequence;
        continue;
      }
      running.set(key, entry.after);
      const effectActionDefinitionId =
        causingEvent !== undefined
          ? resolveCausingEffect(causingEvent, eventBySequence)
          : undefined;
      const causingDetails = causingEvent?.["details"];
      const reason = isRecord(causingDetails) ? stringOf(causingDetails["reason"]) : undefined;
      found.changes.push({
        sequence: causedBySequence,
        amount: entry.after - entry.before,
        ...(effectActionDefinitionId !== undefined ? { effectActionDefinitionId } : {}),
        ...(effectActionDefinitionId === undefined && reason !== undefined ? { reason } : {}),
      });
    }
  }

  function readableSeries(
    battleUnitId: string,
    field: CombatStatField,
    sequence: number,
  ): Series | undefined {
    const found = series.get(seriesKey(battleUnitId, field));
    if (found === undefined || found.initialValue === undefined) {
      return undefined;
    }
    // 不整合を跨いだ時点より後は、値も内訳も出さない。
    if (found.brokenFromSequence !== undefined && sequence > found.brokenFromSequence) {
      return undefined;
    }
    return found;
  }

  return {
    valueBefore(battleUnitId, field, sequence) {
      const found = readableSeries(battleUnitId, field, sequence);
      if (found === undefined) {
        return undefined;
      }
      return found.changes
        .filter((change) => change.sequence < sequence)
        .reduce((value, change) => value + change.amount, found.initialValue ?? 0);
    },
    initialValue(battleUnitId, field) {
      return series.get(seriesKey(battleUnitId, field))?.initialValue;
    },
    contributionsBefore(battleUnitId, field, sequence) {
      const found = readableSeries(battleUnitId, field, sequence);
      if (found === undefined) {
        return [];
      }
      // 付与と失効が打ち消しあった効果は「適用中」ではないので、純増減が0のものは落とす。
      const netByKey = new Map<string, { readonly label: AppliedChange; total: number }>();
      for (const change of found.changes) {
        if (change.sequence >= sequence) {
          continue;
        }
        const key = change.effectActionDefinitionId ?? `reason:${change.reason ?? "-"}`;
        const existing = netByKey.get(key);
        if (existing === undefined) {
          netByKey.set(key, { label: change, total: change.amount });
        } else {
          existing.total += change.amount;
        }
      }
      return [...netByKey.values()]
        .filter((entry) => Math.abs(entry.total) > EPSILON)
        .map((entry) =>
          entry.label.effectActionDefinitionId !== undefined
            ? {
                effectActionDefinitionId: entry.label.effectActionDefinitionId,
                amount: entry.total,
              }
            : { reason: entry.label.reason ?? "-", amount: entry.total },
        );
    },
  };
}
