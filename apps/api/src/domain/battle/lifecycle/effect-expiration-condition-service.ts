import {
  evaluateTriggerCondition,
  type TriggerConditionPayloadSource,
} from "../triggering/trigger-condition-evaluator.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

export interface ExpiringEffectInstance {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
}

/**
 * R-EFF-08「特殊失効条件」: 全ユニットの`AppliedEffect`のうち、`expiration.conditions`
 * を持つインスタンスを、与えられたドメインイベント（`event`）に対して評価する。
 * 配列内のいずれか1つでも成立すれば失効対象とする（OR意味論 — 「Aが解除される
 * と同時に」「Bの付与者が倒れると同時に」のような独立した複数の特殊失効条件を
 * 表すため、AND評価は要求されていない）。評価は`triggering/trigger-condition-
 * evaluator.ts`の`evaluateTriggerCondition`を再利用する（PS Trigger条件と
 * 同じ`ConditionDefinition`表現を共有するため）。`RUNTIME_COUNTER`/
 * `POSITION_RELATION`はAppliedEffectに対応する所有PS/skillDefinitionIdの
 * 文脈が無いため、これらの`kind`を参照する`expiration.conditions`は
 * `evaluateTriggerCondition`が明示的にthrowする（同じ「未対応は明確なエラー」
 * 方針、現時点で本Issueが対象とするproduction Catalog行は存在しない）。
 */
export function findEffectsMatchingExpirationCondition(
  units: readonly BattleUnit[],
  event: TriggerConditionPayloadSource,
): readonly ExpiringEffectInstance[] {
  const matches: ExpiringEffectInstance[] = [];
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      const conditions = effect.duration.definition.expiration?.conditions;
      if (conditions === undefined || conditions.length === 0) {
        continue;
      }
      if (conditions.some((condition) => evaluateTriggerCondition(condition, event))) {
        matches.push({
          battleUnitId: unit.battleUnitId,
          effectInstanceId: effect.effectInstanceId,
        });
      }
    }
  }
  return matches;
}
