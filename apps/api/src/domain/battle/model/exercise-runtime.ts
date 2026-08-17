import { BreakDeferral } from "./break-deferral.js";
import { truncateFraction } from "./resource-gauge.js";
import type { CombatStats } from "./starting-combat-stats.js";

/**
 * `05_ドメインモデル.md`「集約が所有する状態」の戦闘モード。`TACTICAL_EXERCISE`の
 * ときだけR-TEX領域のルールを適用し、`NORMAL`の挙動と既存ルールは変更しない
 * （`07_戦闘ルール詳細.md`「戦術演習（スコアアタック）」前文）。
 */
export const BATTLE_MODES = ["NORMAL", "TACTICAL_EXERCISE"] as const;
export type BattleMode = (typeof BATTLE_MODES)[number];

/**
 * R-TEX-01 #4: 戦術演習の規定ターン数は5で固定であり、APIリクエストでは指定できない。
 * `09_アプリケーション設計.md`の`EXERCISE_TURN_LIMIT`と同じ値を、集約の生成時
 * 不変条件（`createBattle`）が参照できるようDomain側の正本として持つ。
 */
export const EXERCISE_TURN_LIMIT = 5;

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

/** `ExerciseRuntime.deductScore`が実際に減算したときだけ返す差分。 */
export interface ExerciseScoreDeduction {
  /** 実際に減った量。要求量が累計を上回った場合は累計そのもの（下限0のクランプ）。 */
  readonly amount: number;
  readonly before: number;
  readonly after: number;
}

/** `ExerciseRuntime.recordBreak`が返す、1増えたブレイク回数とその差分（R-TEX-03 #4）。 */
export interface ExerciseBreakRecord {
  /** 1から始まるブレイク番号。R-TEX-04の強化量を決める`n`そのもの。 */
  readonly breakNumber: number;
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

  /**
   * R-TEX-04 #4: ブレイク強化が毎回そこから再計算する原基準値（複利にしない）。
   * 戦闘開始時の敵ユニットの基礎戦闘ステータス（編成補正・適性補正適用後）であり、
   * これを書き換えるのはブレイク強化だけであるため、生成時の値をそのまま保持する。
   */
  readonly originalEnemyBaseCombatStats: CombatStats;

  /**
   * R-TEX-03 #5: スキル効果処理フェーズの内側でのHP0到達を保留するフレームスタック。
   *
   * フレームは効果処理フェーズ単位の解決コンテキストであって演習状態の一部ではない
   * （`snapshot`にも`StateDelta`にも現れない）。それでもここに置くのは、`exercise`が
   * 伝播した経路には必ず保留先も伝播していることを構造で保証するためである
   * （`break-deferral.ts`のクラスコメント参照）。
   */
  readonly deferredBreaks = new BreakDeferral();

  constructor(originalEnemyBaseCombatStats: CombatStats) {
    this.originalEnemyBaseCombatStats = originalEnemyBaseCombatStats;
  }

  get totalScore(): number {
    return this.total;
  }

  get breakCount(): number {
    return this.breaks;
  }

  /**
   * R-TEX-02: 敵ユニットのHPへ向かったダメージ量を累計スコアへ加算する。
   * 計上量0（および負の値）では加算せず`undefined`を返す — 呼び出し側は
   * `ExerciseScoreAccumulated`を発行しない（R-TEX-02 #4）。減算は`deductScore`だけが
   * 行うため、負の量はここで捨てる。
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

  /**
   * R-TEX-02 #5: ブレイク復活以外で敵ユニットのHPが増えた量を累計スコアから減算する。
   *
   * 同 #6: 減算量は`min(要求量, 現在の累計)`とし、累計は0未満にしない。実減少量が
   * 0以下（累計が既に0、要求量が0以下、切り捨てで0）の場合は`undefined`を返し、
   * 呼び出し側は`ExerciseScoreDeducted`を発行しない（加算側 #4 と同じ規約）。
   *
   * 下限クランプをここで行うことで、`ExerciseResultResponse.totalScore`の
   * 「integer、0以上」（`10_API設計.md`）が発行経路によらず成立する。
   */
  deductScore(amount: number): ExerciseScoreDeduction | undefined {
    const deductible = Math.min(truncateFraction(amount), this.total);
    if (deductible <= 0) {
      return undefined;
    }
    const before = this.total;
    this.total = before - deductible;
    return { amount: deductible, before, after: this.total };
  }

  /**
   * R-TEX-03 #4: ブレイク回数を1増やし、そのブレイクの番号（1始まり）を返す。
   *
   * 返す`breakNumber`はR-TEX-04が強化量を決める`n`と同一である — 強化は原基準値へ
   * 毎回再計算するため（複利にしない、R-TEX-04 #4）、呼び出し側は増加後の累計回数
   * だけを`applyExerciseScaling`へ渡せばよい。
   */
  recordBreak(): ExerciseBreakRecord {
    const before = this.breaks;
    this.breaks = before + 1;
    return { breakNumber: this.breaks, before, after: this.breaks };
  }

  snapshot(): ExerciseStateSnapshot {
    return { totalScore: this.total, breakCount: this.breaks };
  }
}
