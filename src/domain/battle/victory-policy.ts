export type BattleOutcome = "ALLY_WIN" | "ALLY_LOSE";

export type CompletionReason =
  | "SIMULTANEOUS_DEFEAT"
  | "ENEMY_DEFEATED"
  | "ALLY_DEFEATED"
  | "TURN_LIMIT_REACHED";

export interface VictoryCheckInput {
  readonly allAlliesDefeated: boolean;
  readonly allEnemiesDefeated: boolean;
  /** Only true when evaluated at the turn-ending checkpoint of the final turn (R-END-01). */
  readonly turnLimitReached: boolean;
}

export interface VictoryResult {
  readonly outcome: BattleOutcome;
  readonly completionReason: CompletionReason;
}

/**
 * `VictoryPolicy` (`05_ドメインモデル.md`). R-END-02の優先順を評価する。
 * `undefined` は「戦闘継続」を表す。
 */
export function resolveVictory(input: VictoryCheckInput): VictoryResult | undefined {
  if (input.allAlliesDefeated && input.allEnemiesDefeated) {
    return { outcome: "ALLY_WIN", completionReason: "SIMULTANEOUS_DEFEAT" };
  }
  if (input.allEnemiesDefeated) {
    return { outcome: "ALLY_WIN", completionReason: "ENEMY_DEFEATED" };
  }
  if (input.allAlliesDefeated) {
    return { outcome: "ALLY_LOSE", completionReason: "ALLY_DEFEATED" };
  }
  if (input.turnLimitReached) {
    return { outcome: "ALLY_LOSE", completionReason: "TURN_LIMIT_REACHED" };
  }
  return undefined;
}
