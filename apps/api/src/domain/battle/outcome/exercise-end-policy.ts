import type { CompletionReason } from "./victory-policy.js";

/**
 * R-TEX-09 #1: 演習の終了理由は2つだけ。R-END-02の勝敗優先順が持つ
 * `SIMULTANEOUS_DEFEAT`／`ENEMY_DEFEATED`は演習では成立しない
 * （敵のHP0はブレイクとして同一解決ステップ内で復活まで完了するため、判定
 * タイミングで敵全滅が観測されない、同 #2）。通常戦闘の`CompletionReason`から
 * 導出して、終了理由の語彙が2つのモードで分岐しないようにする。
 */
export type ExerciseCompletionReason = Extract<
  CompletionReason,
  "ALLY_DEFEATED" | "TURN_LIMIT_REACHED"
>;

export interface ExerciseEndCheckInput {
  readonly allAlliesDefeated: boolean;
  /** Only true when evaluated at the turn-ending checkpoint of the fifth turn (R-TEX-01 #4). */
  readonly turnLimitReached: boolean;
}

export interface ExerciseEndResult {
  readonly completionReason: ExerciseCompletionReason;
}

/**
 * `ExerciseEndPolicy`（`05_ドメインモデル.md`）。R-END-01と同じ判定タイミングで
 * R-TEX-09の2条件だけを評価する。`undefined`は「演習継続」を表す。
 *
 * `VictoryCheckInput`と違い敵全滅を入力に持たない — 演習で敵全滅を評価しないことを
 * 呼び出し側の判断ではなく型で固定するためである（R-TEX-09 #2）。
 */
export function resolveExerciseEnd(input: ExerciseEndCheckInput): ExerciseEndResult | undefined {
  if (input.allAlliesDefeated) {
    return { completionReason: "ALLY_DEFEATED" };
  }
  if (input.turnLimitReached) {
    return { completionReason: "TURN_LIMIT_REACHED" };
  }
  return undefined;
}
