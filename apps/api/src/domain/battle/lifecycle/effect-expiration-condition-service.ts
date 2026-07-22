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
 * 同じ`ConditionDefinition`表現を共有するため）。
 *
 * レビュー指摘[P2]（PR #209）: 各`AppliedEffect`ごとに、その効果を保持する
 * ユニット自身を`context.owner`として渡す — PS発動条件と異なり、R-EFF-08では
 * `owner`（`TARGET_STATE`の`SELF`が指す対象）が効果インスタンスごとに変わる
 * （固定のPS所有者という概念が無い）。`getUnit`も`units`全体から解決できる
 * ようにし、`TARGET_STATE`（`ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL`が実際に
 * 使う`SELF`/`IS_ALIVE`を含む）を評価可能にする。`RUNTIME_COUNTER`は
 * `effect.duration.counters`（`AppliedEffect`スコープ、EFF-005/Issue #162）を
 * `context.effectCounters`として渡す — `skillDefinitionId`の代わりにこの
 * counter mapを使って評価する。
 */
export function findEffectsMatchingExpirationCondition(
  units: readonly BattleUnit[],
  event: TriggerConditionPayloadSource,
): readonly ExpiringEffectInstance[] {
  const getUnit = (battleUnitId: BattleUnitId): BattleUnit | undefined =>
    units.find((unit) => unit.battleUnitId === battleUnitId);
  const matches: ExpiringEffectInstance[] = [];
  for (const unit of units) {
    for (const effect of unit.appliedEffects) {
      const conditions = effect.duration.definition.expiration?.conditions;
      if (conditions === undefined || conditions.length === 0) {
        continue;
      }
      const context = { owner: unit, getUnit, effectCounters: effect.duration.counters ?? {} };
      if (conditions.some((condition) => evaluateTriggerCondition(condition, event, context))) {
        matches.push({
          battleUnitId: unit.battleUnitId,
          effectInstanceId: effect.effectInstanceId,
        });
      }
    }
  }
  return matches;
}
