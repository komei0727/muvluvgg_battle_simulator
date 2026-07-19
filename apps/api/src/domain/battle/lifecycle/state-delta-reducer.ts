import type { BattleStateSnapshot, BattleUnitSnapshot } from "./battle-state-snapshot.js";
import type {
  ChargeState,
  CooldownState,
  StateDelta,
  UnitStateDelta,
  ValueChange,
} from "../events/state-delta.js";
import type { RuntimeCounterId, SkillDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { BattleUnitId } from "../../shared/ids.js";

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
  const skillCounters = applyRuntimeCounterDeltas(
    `${path}.skillCounters`,
    unit.skillCounters,
    delta.skillCounters,
  );
  return {
    hp: delta.hp?.after ?? unit.hp,
    ap: delta.ap?.after ?? unit.ap,
    pp: delta.pp?.after ?? unit.pp,
    extraGauge: delta.extraGauge?.after ?? unit.extraGauge,
    ...(cooldowns !== undefined ? { cooldowns } : {}),
    ...(nextCharge !== undefined ? { charge: nextCharge } : {}),
    ...(skillCounters !== undefined ? { skillCounters } : {}),
  };
}

/**
 * `R-EFF-11`（`SkillRuntime`スコープ、Issue #143）: `SkillDefinitionId`→
 * `RuntimeCounterId`の2段キーで、変更されたcounterの`value`だけを既存の
 * `skillCounters`へ差分適用する。
 */
function applyRuntimeCounterDeltas(
  path: string,
  current: BattleUnitSnapshot["skillCounters"],
  deltas: UnitStateDelta["skillCounters"],
): BattleUnitSnapshot["skillCounters"] {
  if (deltas === undefined) {
    return current;
  }
  const next: Record<SkillDefinitionId, Readonly<Record<RuntimeCounterId, number>>> = {
    ...current,
  };
  for (const [skillDefinitionId, counterChanges] of Object.entries(deltas) as [
    SkillDefinitionId,
    Readonly<Record<RuntimeCounterId, ValueChange<number>>>,
  ][]) {
    const existing = next[skillDefinitionId];
    const updated: Record<RuntimeCounterId, number> = { ...existing };
    for (const [counterId, change] of Object.entries(counterChanges) as [
      RuntimeCounterId,
      ValueChange<number>,
    ][]) {
      assertBeforeMatches(`${path}[${skillDefinitionId}][${counterId}]`, existing?.[counterId] ?? 0, change);
      updated[counterId] = change.after;
    }
    next[skillDefinitionId] = updated;
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
