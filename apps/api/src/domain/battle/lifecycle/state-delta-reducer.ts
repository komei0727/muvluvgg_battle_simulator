import type { BattleStateSnapshot, BattleUnitSnapshot } from "./battle-state-snapshot.js";
import type {
  ChargeState,
  CooldownState,
  EffectSnapshot,
  MarkerSnapshot,
  StateDelta,
  UnitStateDelta,
  ValueChange,
} from "../events/state-delta.js";
import type { CombatStats } from "../model/starting-combat-stats.js";
import type { RuntimeCounterId, SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";
import type { EffectInstanceId, MarkerInstanceId } from "../../shared/event-ids.js";

function assertBeforeMatches<T>(path: string, current: T, change: ValueChange<T>): void {
  if (current !== change.before) {
    throw new DomainValidationError(
      path,
      `delta.before (${String(change.before)}) does not match the current value (${String(current)}); the delta sequence is dropped, reordered, or duplicated`,
    );
  }
}

/**
 * `charge`は毎回新しいオブジェクトとして構築される複合値（`ChargeStarted.after`
 * と`ChargeReleased.before`は同じ内容でも別インスタンス）のため、`assertBeforeMatches`
 * の参照同一性（`!==`）比較では正常な開始→発動イベント列でも誤って不一致と
 * 判定してしまう（PR#128レビュー[P1]）。フィールド単位の構造比較で判定する。
 */
export function sameChargeState(a: ChargeState | undefined, b: ChargeState | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.skillDefinitionId === b.skillDefinitionId && a.startedActionId === b.startedActionId;
}

function assertChargeBeforeMatches(
  path: string,
  current: ChargeState | undefined,
  change: ValueChange<ChargeState | undefined>,
): void {
  if (!sameChargeState(current, change.before)) {
    throw new DomainValidationError(
      path,
      `delta.before (${JSON.stringify(change.before)}) does not match the current value (${JSON.stringify(current)}); the delta sequence is dropped, reordered, or duplicated`,
    );
  }
}

/**
 * `RuntimeCounter`の`AppliedEffect`スコープ公開値（EFF-005/Issue #162）。
 * `counters`はキー数が可変な複合値のため、`sameChargeState`と同じ理由で参照
 * 同一性ではなく構造比較を行う。
 */
function sameCounters(
  a: Readonly<Record<RuntimeCounterId, number>> | undefined,
  b: Readonly<Record<RuntimeCounterId, number>> | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every(([counter, value]) => b[counter as RuntimeCounterId] === value);
}

/**
 * `charge`の`sameChargeState`と同じ理由（複合値は呼び出しごとに新しい
 * オブジェクトとして構築されるため参照同一性では判定できない）で、フィールド
 * 単位の構造比較を行う。
 */
export function sameEffectSnapshot(
  a: EffectSnapshot | undefined,
  b: EffectSnapshot | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.effectInstanceId === b.effectInstanceId &&
    a.effectDefinitionId === b.effectDefinitionId &&
    a.sourceUnitId === b.sourceUnitId &&
    a.kindKey === b.kindKey &&
    a.duplicate === b.duplicate &&
    a.isEffective === b.isEffective &&
    a.magnitude === b.magnitude &&
    a.duration?.unit === b.duration?.unit &&
    a.duration?.remaining === b.duration?.remaining &&
    a.consumptionRemaining === b.consumptionRemaining &&
    a.appliedTurnNumber === b.appliedTurnNumber &&
    a.appliedActionId === b.appliedActionId &&
    sameCounters(a.counters, b.counters)
  );
}

/**
 * R-EFF-01: `EffectInstanceId`をキーとする`EffectSnapshot`の差分を適用する。
 * `Map`の挿入順を使い、既存キーの更新は位置を保ったまま、新規キー
 * （`before: undefined`）は末尾へ追加する（`applied-effect.ts`のarray順=付与順を
 * 独立Reducerでも保つ）。
 */
function applyEffectDeltas(
  path: string,
  current: readonly EffectSnapshot[] | undefined,
  deltas: UnitStateDelta["effects"],
): readonly EffectSnapshot[] | undefined {
  if (deltas === undefined) {
    return current;
  }
  const byId = new Map((current ?? []).map((effect) => [effect.effectInstanceId, effect] as const));
  for (const [effectInstanceId, change] of Object.entries(deltas) as [
    EffectInstanceId,
    ValueChange<EffectSnapshot | undefined>,
  ][]) {
    const existing = byId.get(effectInstanceId);
    if (!sameEffectSnapshot(existing, change.before)) {
      throw new DomainValidationError(
        `${path}[${effectInstanceId}]`,
        `delta.before (${JSON.stringify(change.before)}) does not match the current value (${JSON.stringify(existing)}); the delta sequence is dropped, reordered, or duplicated`,
      );
    }
    if (change.after === undefined) {
      byId.delete(effectInstanceId);
    } else {
      byId.set(effectInstanceId, change.after);
    }
  }
  return [...byId.values()];
}

/**
 * `sameEffectSnapshot`と同じ理由・同じ役割の`MarkerSnapshot`版（R-EFF-10）。
 */
export function sameMarkerSnapshot(
  a: MarkerSnapshot | undefined,
  b: MarkerSnapshot | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return (
    a.markerInstanceId === b.markerInstanceId &&
    a.markerId === b.markerId &&
    a.sourceUnitId === b.sourceUnitId &&
    a.stackCount === b.stackCount &&
    a.stackMax === b.stackMax &&
    a.duration?.unit === b.duration?.unit &&
    a.duration?.remaining === b.duration?.remaining &&
    a.consumptionRemaining === b.consumptionRemaining
  );
}

/**
 * R-EFF-10: `applyEffectDeltas`と同じ規約の`MarkerInstanceId`版。`Map`の挿入順を
 * 使い、既存キーの更新は位置を保ったまま、新規キー（`before: undefined`）は
 * 末尾へ追加する。
 */
function applyMarkerDeltas(
  path: string,
  current: readonly MarkerSnapshot[] | undefined,
  deltas: UnitStateDelta["markers"],
): readonly MarkerSnapshot[] | undefined {
  if (deltas === undefined) {
    return current;
  }
  const byId = new Map((current ?? []).map((marker) => [marker.markerInstanceId, marker] as const));
  for (const [markerInstanceId, change] of Object.entries(deltas) as [
    MarkerInstanceId,
    ValueChange<MarkerSnapshot | undefined>,
  ][]) {
    const existing = byId.get(markerInstanceId);
    if (!sameMarkerSnapshot(existing, change.before)) {
      throw new DomainValidationError(
        `${path}[${markerInstanceId}]`,
        `delta.before (${JSON.stringify(change.before)}) does not match the current value (${JSON.stringify(existing)}); the delta sequence is dropped, reordered, or duplicated`,
      );
    }
    if (change.after === undefined) {
      byId.delete(markerInstanceId);
    } else {
      byId.set(markerInstanceId, change.after);
    }
  }
  return [...byId.values()];
}

/**
 * R-STA-04: `CombatStatChanged`が持つ`combatStats`差分を適用する。`hp`/`ap`と
 * 同じ`assertBeforeMatches`規約だが、フィールドごとに個別のキーを持つ複合値
 * のため`hp`のような単一フィールドの比較を`CombatStats`の各キーへ繰り返す。
 */
function applyCombatStatsDelta(
  path: string,
  current: CombatStats,
  deltas: UnitStateDelta["combatStats"],
): CombatStats {
  if (deltas === undefined) {
    return current;
  }
  const next: Record<keyof CombatStats, number> = { ...current };
  for (const [field, change] of Object.entries(deltas) as [
    keyof CombatStats,
    ValueChange<number>,
  ][]) {
    assertBeforeMatches(`${path}.${field}`, current[field], change);
    next[field] = change.after;
  }
  return next;
}

function applyUnitDelta(
  path: string,
  unit: BattleUnitSnapshot,
  delta: UnitStateDelta,
): BattleUnitSnapshot {
  if (delta.hp !== undefined) {
    assertBeforeMatches(`${path}.hp`, unit.hp, delta.hp);
  }
  if (delta.ap !== undefined) {
    assertBeforeMatches(`${path}.ap`, unit.ap, delta.ap);
  }
  if (delta.pp !== undefined) {
    assertBeforeMatches(`${path}.pp`, unit.pp, delta.pp);
  }
  if (delta.extraGauge !== undefined) {
    assertBeforeMatches(`${path}.extraGauge`, unit.extraGauge, delta.extraGauge);
  }
  const cooldowns = applyCooldownDeltas(`${path}.cooldowns`, unit.cooldowns, delta.cooldowns);
  if (delta.charge !== undefined) {
    assertChargeBeforeMatches(`${path}.charge`, unit.charge, delta.charge);
  }
  const nextCharge = delta.charge !== undefined ? delta.charge.after : unit.charge;
  const skillCounters = applyTwoLevelCounterDeltas(
    `${path}.skillCounters`,
    unit.skillCounters,
    delta.skillCounters,
  );
  // レビュー再々々レビュー[P1]: `skillCounterCarry`は`captureBattleState`が
  // carry===0のskillDefinitionIdキーごと省略する（`skillCounters`と違い0を
  // デフォルト値として扱う）ため、Reducer側もdelta適用後に空になった
  // skillDefinitionIdエントリを剪定し、実状態と同じ形へ揃える。
  const skillCounterCarry = applyTwoLevelCounterDeltas(
    `${path}.skillCounterCarry`,
    unit.skillCounterCarry,
    delta.skillCounterCarry,
    { pruneEmptyFirstLevelEntries: true },
  );
  // EFF-006/Issue #212: `EffectSequence`スコープ。`skillCounters`と同じ2段キー
  // だが1段目が`SkillUseId`（1回の解決を識別する既存の実行時識別子）である点だけ
  // が異なる。解決完了時に`RuntimeCounterReset`がキー自体を必ず削除するため、
  // `skillCounterCarry`と同じく空になったら`pruneEmptyFirstLevelEntries`で
  // フィールド自体を省略する。
  const effectSequenceCounters = applyTwoLevelCounterDeltas(
    `${path}.effectSequenceCounters`,
    unit.effectSequenceCounters,
    delta.effectSequenceCounters,
    { pruneEmptyFirstLevelEntries: true },
  );
  const effectSequenceCounterCarry = applyTwoLevelCounterDeltas(
    `${path}.effectSequenceCounterCarry`,
    unit.effectSequenceCounterCarry,
    delta.effectSequenceCounterCarry,
    { pruneEmptyFirstLevelEntries: true },
  );
  const effects = applyEffectDeltas(`${path}.effects`, unit.effects, delta.effects);
  const markers = applyMarkerDeltas(`${path}.markers`, unit.markers, delta.markers);
  const combatStats = applyCombatStatsDelta(
    `${path}.combatStats`,
    unit.combatStats,
    delta.combatStats,
  );
  if (delta.lastDamageDealt !== undefined) {
    assertBeforeMatches(`${path}.lastDamageDealt`, unit.lastDamageDealt, delta.lastDamageDealt);
  }
  if (delta.lastDamageReceived !== undefined) {
    assertBeforeMatches(
      `${path}.lastDamageReceived`,
      unit.lastDamageReceived,
      delta.lastDamageReceived,
    );
  }
  const nextLastDamageDealt =
    delta.lastDamageDealt !== undefined ? delta.lastDamageDealt.after : unit.lastDamageDealt;
  const nextLastDamageReceived =
    delta.lastDamageReceived !== undefined
      ? delta.lastDamageReceived.after
      : unit.lastDamageReceived;
  return {
    hp: delta.hp?.after ?? unit.hp,
    ap: delta.ap?.after ?? unit.ap,
    pp: delta.pp?.after ?? unit.pp,
    extraGauge: delta.extraGauge?.after ?? unit.extraGauge,
    combatStats,
    ...(cooldowns !== undefined ? { cooldowns } : {}),
    ...(nextCharge !== undefined ? { charge: nextCharge } : {}),
    ...(skillCounters !== undefined ? { skillCounters } : {}),
    ...(skillCounterCarry !== undefined ? { skillCounterCarry } : {}),
    ...(effectSequenceCounters !== undefined ? { effectSequenceCounters } : {}),
    ...(effectSequenceCounterCarry !== undefined ? { effectSequenceCounterCarry } : {}),
    ...(effects !== undefined && effects.length > 0 ? { effects } : {}),
    ...(markers !== undefined && markers.length > 0 ? { markers } : {}),
    ...(nextLastDamageDealt !== undefined ? { lastDamageDealt: nextLastDamageDealt } : {}),
    ...(nextLastDamageReceived !== undefined ? { lastDamageReceived: nextLastDamageReceived } : {}),
  };
}

/**
 * `R-EFF-11`（`SkillRuntime`スコープ、Issue #143）: `SkillDefinitionId`→
 * `RuntimeCounterId`の2段キーで運ばれる`skillCounters`（`value`）／
 * `skillCounterCarry`（`carry`、レビュー再々レビュー[P2]）の両方に使う共通
 * 差分適用。`EffectSequence`スコープ（EFF-006、Issue #212）の
 * `effectSequenceCounters`／`effectSequenceCounterCarry`も、1段目のキーが
 * `SkillDefinitionId`ではなく`SkillUseId`であるだけで同じ形のため、1段目キーの
 * 型を`K`として汎用化して再利用する。
 *
 * レビュー指摘[P1]: `change.after === undefined`は`RuntimeCounterReset`による
 * キー自体の削除を表すため、`0`を書き込むのではなく`updated`からキーを
 * `delete`する（実状態の`resetRuntimeCounter`と同じ規約）。
 */
function applyTwoLevelCounterDeltas<K extends string>(
  path: string,
  current: Readonly<Record<K, Readonly<Record<RuntimeCounterId, number>>>> | undefined,
  deltas:
    | Readonly<Record<K, Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>>>
    | undefined,
  options: { readonly pruneEmptyFirstLevelEntries?: boolean } = {},
): Readonly<Record<K, Readonly<Record<RuntimeCounterId, number>>>> | undefined {
  if (deltas === undefined) {
    return current;
  }
  const next: Record<K, Readonly<Record<RuntimeCounterId, number>>> = { ...current } as Record<
    K,
    Readonly<Record<RuntimeCounterId, number>>
  >;
  for (const [firstLevelKey, counterChanges] of Object.entries(deltas) as [
    K,
    Readonly<Record<RuntimeCounterId, ValueChange<number | undefined>>>,
  ][]) {
    const existing = next[firstLevelKey];
    const updated: Record<RuntimeCounterId, number> = { ...existing };
    for (const [counterId, change] of Object.entries(counterChanges) as [
      RuntimeCounterId,
      ValueChange<number | undefined>,
    ][]) {
      assertBeforeMatches(
        `${path}[${firstLevelKey}][${counterId}]`,
        existing?.[counterId] ?? 0,
        change,
      );
      if (change.after === undefined) {
        delete updated[counterId];
      } else {
        updated[counterId] = change.after;
      }
    }
    if (options.pruneEmptyFirstLevelEntries === true && Object.keys(updated).length === 0) {
      delete next[firstLevelKey];
    } else {
      next[firstLevelKey] = updated;
    }
  }
  // レビュー再々々々レビュー[P1]: `skillCounterCarry`（`pruneEmptyFirstLevelEntries`）は、
  // 剪定の結果すべての1段目キーエントリが消えた場合、`{}`ではなく
  // `undefined`を返す。`captureBattleState`は非0のcarryが1件も無ければ
  // `skillCounterCarry`フィールド自体を省略するため、呼び出し元
  // （`applyUnitDelta`）がこのフィールド自体を省略できるようにする
  // （`skillCounters`は逆に空でもキーを保持する既存の非対称な規約のため、
  // このフィールド全体省略は`pruneEmptyFirstLevelEntries`のときだけ行う）。
  if (options.pruneEmptyFirstLevelEntries === true && Object.keys(next).length === 0) {
    return undefined;
  }
  return next;
}

/**
 * R-SKL-04: 変更されたスキルのクールタイムだけを既存の`cooldowns`へ差分適用する。
 * `setActionId`/`setTurnNumber`は初回設定時のdeltaだけが持つため、以降の変更
 * （`setActionId`/`setTurnNumber`を含まないdelta）では既存値をそのまま引き継ぐ。
 */
function applyCooldownDeltas(
  path: string,
  current: Readonly<Record<SkillDefinitionId, CooldownState>> | undefined,
  deltas: UnitStateDelta["cooldowns"],
): Readonly<Record<SkillDefinitionId, CooldownState>> | undefined {
  if (deltas === undefined) {
    return current;
  }
  const next: Record<SkillDefinitionId, CooldownState> = { ...current };
  for (const [skillDefinitionId, change] of Object.entries(deltas) as [
    SkillDefinitionId,
    {
      readonly unit: CooldownState["unit"];
      readonly setActionId?: CooldownState["setActionId"];
      readonly setTurnNumber?: CooldownState["setTurnNumber"];
    } & ValueChange<number>,
  ][]) {
    const existing = next[skillDefinitionId];
    assertBeforeMatches(`${path}[${skillDefinitionId}]`, existing?.remaining ?? 0, change);
    const setActionId = change.setActionId ?? existing?.setActionId;
    const setTurnNumber = change.setTurnNumber ?? existing?.setTurnNumber;
    next[skillDefinitionId] = {
      unit: change.unit,
      remaining: change.after,
      ...(setActionId !== undefined ? { setActionId } : {}),
      ...(setTurnNumber !== undefined ? { setTurnNumber } : {}),
    };
  }
  return next;
}

/**
 * `08_ドメインイベント.md`「状態復元」の独立Reducer。Battle集約自身の遷移ロジック
 * を経由せず、`StateDelta` だけから次状態を求める。変更のないフィールドは
 * そのまま引き継ぐ（「変更した項目だけを...記録する」）。適用前に各`before`が
 * 現在値と一致すること、および対象unitが存在することを検証し、差分の抜け・
 * 順序違反・重複適用を、黙って復元不能な状態を返す代わりに例外として検出する。
 */
export function applyStateDelta(
  state: BattleStateSnapshot,
  delta: StateDelta,
): BattleStateSnapshot {
  const units: Record<BattleUnitId, BattleUnitSnapshot> = { ...state.units };
  if (delta.units !== undefined) {
    for (const [unitId, unitDelta] of Object.entries(delta.units) as [
      BattleUnitId,
      UnitStateDelta,
    ][]) {
      const current = units[unitId];
      if (current === undefined) {
        throw new DomainValidationError(
          `delta.units[${unitId}]`,
          "references a BattleUnitId absent from the current state",
        );
      }
      units[unitId] = applyUnitDelta(`delta.units[${unitId}]`, current, unitDelta);
    }
  }
  if (delta.battleStatus !== undefined) {
    assertBeforeMatches("delta.battleStatus", state.status, delta.battleStatus);
  }
  if (delta.turnNumber !== undefined) {
    assertBeforeMatches("delta.turnNumber", state.currentTurn, delta.turnNumber);
  }
  if (delta.result !== undefined) {
    assertBeforeMatches("delta.result", state.result, delta.result);
  }
  const nextResult = delta.result !== undefined ? delta.result.after : state.result;
  return {
    status: delta.battleStatus?.after ?? state.status,
    currentTurn: delta.turnNumber?.after ?? state.currentTurn,
    units,
    ...(nextResult !== undefined ? { result: nextResult } : {}),
  };
}

/** `stateAt(sequence N) = initialState + delta(1) + delta(2) + ... + delta(N)` (`08_ドメインイベント.md`「状態復元」)。 */
export function reduceStateDeltas(
  initialState: BattleStateSnapshot,
  deltas: readonly StateDelta[],
): BattleStateSnapshot {
  return deltas.reduce(applyStateDelta, initialState);
}
