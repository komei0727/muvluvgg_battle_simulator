import type { RuntimeCounterId } from "../../catalog/definitions/catalog-ids.js";

/**
 * `05_ドメインモデル.md`「RuntimeCounter」のM6最小実装（`SkillRuntime`スコープ、
 * Issue #143）。`value`は`RUNTIME_COUNTER` Conditionが参照する公開値、`carry`は
 * `CUMULATIVE_DAMAGE_THRESHOLD`が次回更新へ繰り越す端数（`R-EFF-11`）専用の
 * 内部状態で、`INCREMENT`更新では常に0のまま使わない。
 */
export interface RuntimeCounterEntry {
  readonly value: number;
  readonly carry: number;
}

export type RuntimeCounterMap = Readonly<Record<RuntimeCounterId, RuntimeCounterEntry>>;

export interface RuntimeCounterChange {
  readonly counter: RuntimeCounterId;
  readonly before: number;
  readonly after: number;
}

function getEntry(counters: RuntimeCounterMap, counterId: RuntimeCounterId): RuntimeCounterEntry {
  return counters[counterId] ?? { value: 0, carry: 0 };
}

/** `RUNTIME_COUNTER_MODULO`: 発動回数・N回ごと条件用のcounterを1件分更新する。 */
export function incrementRuntimeCounter(
  counters: RuntimeCounterMap,
  counterId: RuntimeCounterId,
  amount: number,
): { readonly counters: RuntimeCounterMap; readonly change: RuntimeCounterChange } {
  const before = getEntry(counters, counterId).value;
  const after = before + amount;
  return {
    counters: { ...counters, [counterId]: { value: after, carry: 0 } },
    change: { counter: counterId, before, after },
  };
}

/**
 * `CUMULATIVE_DAMAGE_THRESHOLD_TRIGGER`: 対象の最大HP比の閾値ごとに`value`を
 * 1つずつ進める。1回の更新で複数回分の閾値を超えた場合はその回数だけ`value`を
 * 進め、閾値未満の端数を`carry`として次回の更新へ繰り越す（`R-EFF-11`）。
 */
export function applyCumulativeDamageThreshold(
  counters: RuntimeCounterMap,
  counterId: RuntimeCounterId,
  damageAmount: number,
  maximumHp: number,
  maxHpRatio: number,
): { readonly counters: RuntimeCounterMap; readonly change: RuntimeCounterChange } {
  const entry = getEntry(counters, counterId);
  const thresholdAmount = maximumHp * maxHpRatio;
  const total = entry.carry + damageAmount;
  const crossings = Math.floor(total / thresholdAmount);
  const carry = total - crossings * thresholdAmount;
  const before = entry.value;
  const after = before + crossings;
  return {
    counters: { ...counters, [counterId]: { value: after, carry } },
    change: { counter: counterId, before, after },
  };
}

/**
 * `R-EFF-11`「解決スコープ終了時にリセットするcounter」。未設定のcounterへの
 * リセットはno-opとして`undefined`を返す（`CooldownPolicy`の
 * `manipulateCooldown`と同じ規約）。
 */
export function resetRuntimeCounter(
  counters: RuntimeCounterMap,
  counterId: RuntimeCounterId,
): { readonly counters: RuntimeCounterMap; readonly change: RuntimeCounterChange } | undefined {
  const entry = counters[counterId];
  if (entry === undefined) {
    return undefined;
  }
  const next = { ...counters };
  delete (next as Record<RuntimeCounterId, RuntimeCounterEntry>)[counterId];
  return { counters: next, change: { counter: counterId, before: entry.value, after: 0 } };
}
