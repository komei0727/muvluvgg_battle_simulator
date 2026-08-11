import { truncateFraction } from "./resource-gauge.js";

/**
 * `05_ドメインモデル.md`「集約が所有する状態」の戦闘モード。`TACTICAL_EXERCISE`の
 * ときだけR-TEX領域のルールを適用し、`NORMAL`の挙動と既存ルールは変更しない
 * （`07_戦闘ルール詳細.md`「戦術演習（スコアアタック）」前文）。
 */
export type BattleMode = "NORMAL" | "TACTICAL_EXERCISE";

/** `BattleStateSnapshot`へ射影する、演習状態の不変な写し（R-TEX-02／R-TEX-10）。 */
export interface ExerciseStateSnapshot {
  readonly totalScore: number;
  readonly breakCount: number;
}

/** `ExerciseRuntime.accumulateScore`が実際に加算したときだけ返す差分。 */
export interface ExerciseScoreAccumulation {
  readonly amount: number;
  readonly before: number;
  readonly after: number;
}

/**
 * `05_ドメインモデル.md`「演習状態（戦術演習のみ）：累計スコア、ブレイク回数」を
 * 保持する、戦闘モードが`TACTICAL_EXERCISE`のときだけ生成される可変オブジェクト。
 *
 * `EventRecorder`と同じ扱いにする — Battle 1つの生存期間につき1インスタンスを
 * 生成し、解決経路の関数群へ参照を渡して内部で蓄積させる。スコアはダメージ適用の
 * 最深部（`combat/`・`lifecycle/`のダメージ発行箇所）で積み上がる一方、集約状態
 * としてはBattleが所有するため、両者が同じ実体を指す必要があるからである。
 */
export class ExerciseRuntime {
  private total = 0;
  private breaks = 0;

  get totalScore(): number {
    return this.total;
  }

  get breakCount(): number {
    return this.breaks;
  }

  /**
   * R-TEX-02: 敵ユニットのHPへ向かったダメージ量を累計スコアへ加算する。
   * 計上量0（および負の値）では加算せず`undefined`を返す — 呼び出し側は
   * `ExerciseScoreAccumulated`を発行しない（R-TEX-02 #4）。スコアは単調増加で
   * あり減算しない（同 #5）ため、負の量はここで捨てる。
   *
   * R-NUM-02: 累計は整数で持つ。ダメージ量は各経路が既に整数化しているが、
   * スコアの整数性をこの1か所で担保して呼び出し側の前提に依存しないようにする。
   */
  accumulateScore(amount: number): ExerciseScoreAccumulation | undefined {
    const accountable = truncateFraction(amount);
    if (accountable <= 0) {
      return undefined;
    }
    const before = this.total;
    this.total = before + accountable;
    return { amount: accountable, before, after: this.total };
  }

  snapshot(): ExerciseStateSnapshot {
    return { totalScore: this.total, breakCount: this.breaks };
  }
}
