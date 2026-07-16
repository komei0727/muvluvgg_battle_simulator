import type { BattleStateSnapshot, BattleUnitSnapshot } from "./battle-state-snapshot.js";
import type { CooldownState, StateDelta, UnitStateDelta, ValueChange } from "./state-delta.js";
import type { SkillDefinitionId } from "../../catalog/catalog-ids.js";
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
    assertBeforeMatches(`${path}.charge`, unit.charge, delta.charge);
  }
  const nextCharge = delta.charge !== undefined ? delta.charge.after : unit.charge;
  return {
    hp: delta.hp?.after ?? unit.hp,
    ap: delta.ap?.after ?? unit.ap,
    pp: delta.pp?.after ?? unit.pp,
    extraGauge: delta.extraGauge?.after ?? unit.extraGauge,
    ...(cooldowns !== undefined ? { cooldowns } : {}),
    ...(nextCharge !== undefined ? { charge: nextCharge } : {}),
  };
}

/** R-SKL-04: 変更されたスキルのクールタイムだけを既存の`cooldowns`へ差分適用する。 */
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
    { readonly unit: CooldownState["unit"] } & ValueChange<number>,
  ][]) {
    const existing = next[skillDefinitionId];
    assertBeforeMatches(`${path}[${skillDefinitionId}]`, existing?.remaining ?? 0, change);
    next[skillDefinitionId] = { unit: change.unit, remaining: change.after };
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
