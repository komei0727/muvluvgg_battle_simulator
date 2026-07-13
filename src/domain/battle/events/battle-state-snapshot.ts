import type { BattleResultSnapshot } from "./state-delta.js";
import type { Battle } from "../battle.js";
import type { BattleStatus } from "../battle-status.js";
import type { BattleUnitId } from "../../shared/ids.js";

export type { BattleResultSnapshot } from "./state-delta.js";

export interface BattleUnitSnapshot {
  readonly hp: number;
  readonly ap: number;
  readonly pp: number;
  readonly extraGauge: number;
}

/**
 * `08_ドメインイベント.md`「状態復元」のinitialState/finalStateに相当する、
 * Battleの可変状態だけを抜き出した不変スナップショット。`result`は勝敗確定後
 * だけ持つ（`Battle.result`と同じく、READY/RUNNING中は`undefined`）。
 */
export interface BattleStateSnapshot {
  readonly status: BattleStatus;
  readonly currentTurn: number;
  readonly units: Readonly<Record<BattleUnitId, BattleUnitSnapshot>>;
  readonly result?: BattleResultSnapshot;
}

/** Battle集約から状態差分の対象になりうる可変状態だけを射影する。 */
export function captureBattleState(battle: Battle): BattleStateSnapshot {
  const units: Record<BattleUnitId, BattleUnitSnapshot> = {};
  for (const unit of [...battle.allyUnits, ...battle.enemyUnits]) {
    units[unit.battleUnitId] = {
      hp: unit.currentHp,
      ap: unit.currentAp,
      pp: unit.currentPp,
      extraGauge: unit.currentExtraGauge,
    };
  }
  return {
    status: battle.status,
    currentTurn: battle.turnState.currentTurn,
    units,
    ...(battle.result !== undefined ? { result: battle.result } : {}),
  };
}
