import { resolveExerciseEnd, type ExerciseEndResult } from "./exercise-end-policy.js";
import { resolveVictory, type VictoryCheckInput, type VictoryResult } from "./victory-policy.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { TotalWarFormations } from "../model/total-war-formations.js";
import { resolveTotalWarCheckpoint, type FormationDefeat } from "./total-war-checkpoint.js";

/** 判定タイミングで確定した結果。通常戦闘は勝敗を持ち、演習は終了理由だけを持つ（R-TEX-10 #1）。 */
export type CompletionCheckResult = VictoryResult | ExerciseEndResult;

/**
 * `06_戦闘状態遷移.md`「判定タイミング」で共有する観測。通常戦闘・演習の
 * どちらでも同じ観測から判定するため、入力は1つにまとめる。
 */
export type CompletionCheckInput = VictoryCheckInput;

/**
 * `06_戦闘状態遷移.md`「判定タイミング」／「戦術演習の判定」: 3つの判定タイミング
 * （1行動とPS連鎖の完了後、ターン開始後、ターン終了後）で、モードに応じた終了判定を
 * 行う。通常戦闘はR-END-02の勝敗優先順（`VictoryPolicy`）、演習はR-TEX-09の2条件
 * （`ExerciseEndPolicy`）だけを評価する。`undefined`は「戦闘継続」を表す。
 *
 * 演習状態の有無をモード判別子として受け取る — 判定タイミングは集約
 * （`advanceBattle`）と行動フェーズ（`resolveActionPhase`）に分かれており、後者が
 * 受け取っているモードの手がかりは`ExerciseRuntime`の参照そのものだからである。
 * 判定タイミングごとにモードの分岐を書き写すと、片方だけ勝敗判定のまま残る形で
 * R-TEX-09 #2に反し得るため、分岐はこの1か所に閉じる。
 */
export function resolveCompletionAt(
  exercise: ExerciseRuntime | undefined,
  input: CompletionCheckInput,
): CompletionCheckResult | undefined {
  if (exercise !== undefined) {
    return resolveExerciseEnd({
      allAlliesDefeated: input.allAlliesDefeated,
      turnLimitReached: input.turnLimitReached,
    });
  }
  return resolveVictory(input);
}

/** 判定タイミングがモードを見分けるための状態。演習は`exercise`、総力戦は`totalWarFormations`を持つ。 */
export interface CompletionCheckpointMode {
  readonly exercise?: ExerciseRuntime;
  readonly totalWarFormations?: TotalWarFormations;
}

export interface CompletionCheckpointOutcome {
  readonly completion: CompletionCheckResult | undefined;
  /** 総力戦だけが持つ、判定後の編成状態。 */
  readonly totalWarFormations?: TotalWarFormations;
  /** 総力戦でこの判定タイミングが新たに検出した編成の全滅。他のモードでは常に空。 */
  readonly formationDefeats: readonly FormationDefeat[];
  /**
   * 総力戦で、出撃中の編成が全滅して交代を待つ陣営がある（R-TWR-03 #4）。
   * 行動フェーズを打ち切る合図であり、他のモードでは常に`false`。
   */
  readonly awaitingDeployment: boolean;
}

/**
 * 3つの判定タイミングが共通に使う判定。総力戦では編成の全滅を検出してから終了判定を行い
 * （R-TWR-03）、それ以外のモードでは`resolveCompletionAt`と同じ判定を行う。
 */
export function evaluateCompletionCheckpoint(
  mode: CompletionCheckpointMode,
  units: readonly BattleUnit[],
  turnLimitReached: boolean,
): CompletionCheckpointOutcome {
  if (mode.totalWarFormations !== undefined) {
    const checked = resolveTotalWarCheckpoint(mode.totalWarFormations, units, turnLimitReached);
    return {
      completion: checked.completion,
      totalWarFormations: checked.formations,
      formationDefeats: checked.defeats,
      awaitingDeployment: checked.awaitingDeployment,
    };
  }
  const completion = resolveCompletionAt(mode.exercise, {
    allAlliesDefeated: units.filter((unit) => unit.side === "ALLY").every(isDefeated),
    allEnemiesDefeated: units.filter((unit) => unit.side === "ENEMY").every(isDefeated),
    turnLimitReached,
  });
  return { completion, formationDefeats: [], awaitingDeployment: false };
}
