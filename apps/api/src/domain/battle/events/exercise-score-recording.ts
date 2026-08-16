import type { EventRecorder } from "./event-recorder.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";

/** `ExerciseScoreAccumulated`／`ExerciseScoreDeducted`の発行に必要な最小の因果関係コンテキスト。 */
export interface ExerciseScoreEventContext {
  readonly recorder: EventRecorder;
  readonly turnNumber: number;
  readonly cycleNumber: number;
  readonly actionId?: ActionId;
  readonly skillUseId?: SkillUseId;
  readonly resolutionScopeId: ResolutionScopeId;
  readonly rootEventId: DomainEventId;
}

/**
 * R-TEX-02: 敵ユニットのHPへ向かったダメージを累計スコアへ計上し、
 * `ExerciseScoreAccumulated`を発行する。戻り値は後続イベントが親に使える
 * 最新イベントID（計上が発生しなければ`causeEventId`のまま）。
 *
 * ダメージ経路（通常ヒット・継続ダメージ）ごとに計上量の求め方は異なるが、計上の
 * 判定・加算・イベント発行はここへ集約する — R-TEX-02「ダメージの発生源・種別は
 * 問わない」を、経路ごとの再実装ではなく単一の規則として持たせるためである。
 *
 * `hitPointDamage`はHPへ向かった量であり、残HPによる切り捨て（オーバーキル分）を
 * 含む。致死ダメージ耐え（R-INT-01）で実際にはHPが0で止まった場合も、耐えた
 * ダメージの全量を計上する（R-TEX-08 #3）。
 *
 * 計上対象は「ダメージ」に限る。`MODIFY_RESOURCE`によるHP減少は計上しない —
 * R-TEX-02がスコアを「HPへ向かったダメージ」と定めるのに対し、R-TEX-03の
 * ブレイク判定だけが到達経路として「リソース操作等」を明示的に含めており、
 * 両者の対象範囲は設計上一致しない。
 */
export function recordExerciseScoreIfAny(
  exercise: ExerciseRuntime | undefined,
  context: ExerciseScoreEventContext,
  target: BattleUnit,
  hitPointDamage: number,
  causeEventId: DomainEventId,
): DomainEventId {
  // 通常戦闘（演習状態なし）と、味方へ向かったダメージは計上しない。演習の敵陣営は
  // ちょうど1体（R-TEX-01 #3）のため、陣営の判定が「敵ユニットのHPへ向かった
  // ダメージ」の判定と一致する。
  if (exercise === undefined || target.side !== "ENEMY") {
    return causeEventId;
  }
  const accumulation = exercise.accumulateScore(hitPointDamage);
  if (accumulation === undefined) {
    return causeEventId;
  }
  const accumulated = context.recorder.record({
    eventType: "ExerciseScoreAccumulated",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: causeEventId,
    rootEventId: context.rootEventId,
    targetUnitIds: [target.battleUnitId],
    payload: {
      targetUnitId: target.battleUnitId,
      amount: accumulation.amount,
      totalScore: accumulation.after,
      causeEventId,
    },
    stateDelta: {
      exercise: { totalScore: { before: accumulation.before, after: accumulation.after } },
    },
  });
  return accumulated.eventId;
}

/**
 * R-TEX-02 #5: ブレイク復活以外で敵ユニットのHPが増えた量を累計スコアから減算し、
 * `ExerciseScoreDeducted`を発行する。戻り値は後続イベントが親に使える最新イベントID
 * （減算が発生しなければ`causeEventId`のまま）。
 *
 * 判定を`recordExerciseScoreIfAny`と同じくこのファイルへ集約する — 回復経路
 * （`HealApplied`・`HealingTransferred`・`DamageConvertedToHeal`）ごとに
 * 「演習中かつ対象が敵陣営」を再実装すると、経路の追加で減算が抜ける。
 *
 * 渡すのは**実際にHPが増えた量**に限る。最大HP超過で破棄された分は敵HPを増やして
 * いないため呼び出し側が除いておく。
 *
 * 減算対象外（呼び出し側がそもそもこの関数を呼ばない）は次の2つである。
 * - ブレイク復活の全回復（`UnitRevived`、R-TEX-05 #3）。ブレイクは演習の得点機構
 *   そのものであり、R-TEX-05 #4 が「回復に該当しない」と定めている。
 * - `MODIFY_RESOURCE`によるHP増加。加算側が`MODIFY_RESOURCE`によるHP減少を計上
 *   しない（`recordExerciseScoreIfAny`）ことと対称に保つ。
 */
export function recordExerciseScoreDeductionIfAny(
  exercise: ExerciseRuntime | undefined,
  context: ExerciseScoreEventContext,
  target: BattleUnit,
  appliedHealAmount: number,
  causeEventId: DomainEventId,
): DomainEventId {
  // 加算側とまったく同じ判定 — 通常戦闘と、味方のHP増加は減算しない。
  if (exercise === undefined || target.side !== "ENEMY") {
    return causeEventId;
  }
  const deduction = exercise.deductScore(appliedHealAmount);
  if (deduction === undefined) {
    return causeEventId;
  }
  const deducted = context.recorder.record({
    eventType: "ExerciseScoreDeducted",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    ...(context.skillUseId !== undefined ? { skillUseId: context.skillUseId } : {}),
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: causeEventId,
    rootEventId: context.rootEventId,
    targetUnitIds: [target.battleUnitId],
    payload: {
      targetUnitId: target.battleUnitId,
      amount: deduction.amount,
      totalScore: deduction.after,
      causeEventId,
    },
    stateDelta: {
      exercise: { totalScore: { before: deduction.before, after: deduction.after } },
    },
  });
  return deducted.eventId;
}
