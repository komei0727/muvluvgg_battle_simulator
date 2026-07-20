import type { AppliedEffect } from "../model/applied-effect.js";
import {
  evaluateTriggerCondition,
  type RuntimeCounterLookupContext,
  type TriggerConditionPayloadSource,
} from "../triggering/trigger-condition-evaluator.js";

/**
 * R-EFF-08: `expiration.conditions`は関連するドメインイベント発行後、PS/Memory
 * 候補の抽出前に評価する。既存の`evaluateTriggerCondition`（PS trigger評価が
 * 使う汎用条件評価器）をそのまま再利用する — 条件の意味論はtrigger評価と同じ
 * であり、専用の評価器を別に作らない。配列内の複数条件はOR（いずれか1つの
 * 成立で失効する、複数の独立した特殊失効理由を表す）として扱う。AND/NOTで
 * 複数条件を合成したい場合は`ConditionDefinition`自体のAND/OR/NOTノードを使う。
 */
export function findEffectsWithSatisfiedExpiration(
  effects: readonly AppliedEffect[],
  event: TriggerConditionPayloadSource,
  context?: RuntimeCounterLookupContext,
): readonly AppliedEffect[] {
  return effects.filter((effect) => {
    const conditions = effect.duration.definition.expiration?.conditions;
    if (conditions === undefined || conditions.length === 0) {
      return false;
    }
    return conditions.some((condition) => evaluateTriggerCondition(condition, event, context));
  });
}
