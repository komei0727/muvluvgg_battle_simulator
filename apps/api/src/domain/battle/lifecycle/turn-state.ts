import type { TurnLimit } from "../model/turn-limit.js";

/** `13_実装計画.md` の TurnState: 現在ターンと規定ターン数を保持する。 */
export interface TurnState {
  readonly currentTurn: number;
  readonly turnLimit: TurnLimit;
}

/** Battle生成直後: まだどのターンも開始していない（06_戦闘状態遷移.md TURN_STARTING前）。 */
export function createTurnState(turnLimit: TurnLimit): TurnState {
  return { currentTurn: 0, turnLimit };
}

/** 06_戦闘状態遷移.md TURN_STARTING #1: ターン番号を1増やす。初回は1とする。 */
export function beginNextTurn(state: TurnState): TurnState {
  return { ...state, currentTurn: state.currentTurn + 1 };
}

/** R-END-02優先順4の前提: 現在ターンが規定ターン数に達しているか。 */
export function isFinalTurn(state: TurnState): boolean {
  return state.currentTurn >= state.turnLimit;
}
