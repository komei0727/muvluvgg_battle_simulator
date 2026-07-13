import type { BattleStateSnapshot, BattleUnitSnapshot } from "./battle-state-snapshot.js";
import type { StateDelta, UnitStateDelta } from "./state-delta.js";
import type { BattleUnitId } from "../../shared/ids.js";

function applyUnitDelta(unit: BattleUnitSnapshot, delta: UnitStateDelta): BattleUnitSnapshot {
  return {
    hp: delta.hp?.after ?? unit.hp,
    ap: delta.ap?.after ?? unit.ap,
    pp: delta.pp?.after ?? unit.pp,
    extraGauge: delta.extraGauge?.after ?? unit.extraGauge,
  };
}

/**
 * `08_ドメインイベント.md`「状態復元」の独立Reducer。Battle集約自身の遷移ロジック
 * を経由せず、`StateDelta` だけから次状態を求める。変更のないフィールドは
 * そのまま引き継ぐ（「変更した項目だけを...記録する」）。
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
      if (current !== undefined) {
        units[unitId] = applyUnitDelta(current, unitDelta);
      }
    }
  }
  return {
    status: delta.battleStatus?.after ?? state.status,
    currentTurn: delta.turnNumber?.after ?? state.currentTurn,
    units,
  };
}

/** `stateAt(sequence N) = initialState + delta(1) + delta(2) + ... + delta(N)` (`08_ドメインイベント.md`「状態復元」)。 */
export function reduceStateDeltas(
  initialState: BattleStateSnapshot,
  deltas: readonly StateDelta[],
): BattleStateSnapshot {
  return deltas.reduce(applyStateDelta, initialState);
}
