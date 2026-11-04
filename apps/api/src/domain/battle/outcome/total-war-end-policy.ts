import type { BattleOutcome, CompletionReason } from "./victory-policy.js";

/** R-TWR-06 #1: 総力戦の勝敗は、通常戦闘の勝敗に引き分けを加えたもの。 */
export type TotalWarOutcome = BattleOutcome | "DRAW";

export interface TotalWarEndCheckInput {
  /** 出撃中の編成が全滅し、控えも残らない（戦闘可能な編成が残らない）。 */
  readonly allyOutOfFormations: boolean;
  readonly enemyOutOfFormations: boolean;
  /** 規定ターン数（15）のターン終了の判定タイミングでだけtrue。 */
  readonly turnLimitReached: boolean;
}

export interface TotalWarEndResult {
  readonly outcome: TotalWarOutcome;
  readonly completionReason: CompletionReason;
}

/**
 * `TotalWarEndPolicy`（`05_ドメインモデル.md`）。R-END-02に代えて、R-TWR-06 #1の優先順を
 * 評価する。`undefined`は「戦闘継続」を表す。
 *
 * 入力は陣営ごとの「戦闘可能な編成が残らない」だけにする — 控えが残る陣営の編成の全滅を
 * 負けとして渡せないことを型で固定し、片方だけ控えが残る同時全滅を控えの残る側の勝ちにする
 * （同 #3）。引き分けは残りの編成数やHPで判定し直さない（同 #2）。
 */
export function resolveTotalWarEnd(input: TotalWarEndCheckInput): TotalWarEndResult | undefined {
  if (input.allyOutOfFormations && input.enemyOutOfFormations) {
    return { outcome: "DRAW", completionReason: "SIMULTANEOUS_DEFEAT" };
  }
  if (input.enemyOutOfFormations) {
    return { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" };
  }
  if (input.allyOutOfFormations) {
    return { outcome: "ALLY_LOSE", completionReason: "ALLY_DEFEATED" };
  }
  if (input.turnLimitReached) {
    return { outcome: "DRAW", completionReason: "TURN_LIMIT_REACHED" };
  }
  return undefined;
}
