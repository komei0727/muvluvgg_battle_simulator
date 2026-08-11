import type { EventRecorder } from "./event-recorder.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { ExerciseRuntime } from "../model/exercise-runtime.js";
import type {
  ActionId,
  DomainEventId,
  ResolutionScopeId,
  SkillUseId,
} from "../../shared/event-ids.js";

/** `ExerciseScoreAccumulated`の発行に必要な最小の因果関係コンテキスト。 */
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
