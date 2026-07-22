import type { RuntimeCounterId } from "../../catalog/definitions/catalog-ids.js";
import type { RuntimeCounterUpdateDefinition } from "../../catalog/definitions/runtime-counter-update-definition.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { applyUpdate } from "./runtime-counter-matcher.js";
import { evaluateTriggerCondition } from "./trigger-condition-evaluator.js";
import { evaluateSourceSelector, evaluateTargetSelector } from "./trigger-selector-evaluator.js";
import type { TriggerCandidateEvent } from "./trigger-event.js";

export interface EffectRuntimeCounterUpdateResult {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
  readonly counter: RuntimeCounterId;
  readonly before: number;
  readonly after: number;
  readonly carry: number;
  readonly carryBefore: number;
  readonly valueChanged: boolean;
}

/** `matchEffectRuntimeCounterUpdates`が1件マッチしたとして報告する、更新前の(所有ユニット・効果インスタンス・更新定義)の組。 */
export interface MatchedEffectRuntimeCounterUpdate {
  readonly battleUnitId: BattleUnitId;
  readonly effectInstanceId: EffectInstanceId;
  readonly update: RuntimeCounterUpdateDefinition;
}

/**
 * `R-EFF-11`「`AppliedEffect`スコープ」（EFF-005/Issue #162）: 各ユニットが保持する
 * `AppliedEffect`ごとに、その`duration.definition.counterUpdates`を`event`へ照合する。
 * `runtime-counter-matcher.ts`の`matchRuntimeCounterUpdates`（`SKILL_RUNTIME`スコープ、
 * `SkillDefinition.counterUpdates`）と同じ「マッチングだけを行い、値は適用しない」
 * 決定論的な列挙（Unit→そのUnitが保持するAppliedEffect→`counterUpdates`配列順）。
 * `owner`（`TriggerDefinition.sourceSelector`/`targetSelector`のSELFが指す対象、
 * および`RUNTIME_COUNTER`条件が`effectCounters`を読む対象ユニット）は効果の保持者
 * （`unit`自身）とする — `R-EFF-08`の`expiration.conditions`評価と同じ規約。
 */
export function matchEffectRuntimeCounterUpdates(
  units: readonly BattleUnit[],
  event: TriggerCandidateEvent,
): readonly MatchedEffectRuntimeCounterUpdate[] {
  const unitsById = new Map(units.map((u) => [u.battleUnitId, u] as const));
  const matched: MatchedEffectRuntimeCounterUpdate[] = [];

  for (const holder of units) {
    if (isDefeated(holder)) {
      continue;
    }
    for (const effect of holder.appliedEffects) {
      const counterUpdates = effect.duration.definition.counterUpdates;
      if (counterUpdates === undefined || counterUpdates.length === 0) {
        continue;
      }
      for (const update of counterUpdates) {
        if (update.scope !== "APPLIED_EFFECT") {
          throw new DomainValidationError(
            "counterUpdates.scope",
            `scope "${update.scope}" is not supported here (DurationDefinition.counterUpdates only supports APPLIED_EFFECT scope, EFF-005/Issue #162)`,
          );
        }
        const trigger = update.trigger;
        const matches =
          trigger.eventType === event.eventType &&
          trigger.category === event.category &&
          evaluateSourceSelector(trigger.sourceSelector, holder, event, unitsById) &&
          evaluateTargetSelector(trigger.targetSelector, holder, event, unitsById) &&
          evaluateTriggerCondition(trigger.condition, event, {
            owner: holder,
            effectCounters: effect.duration.counters ?? {},
          });
        if (!matches) {
          continue;
        }
        matched.push({
          battleUnitId: holder.battleUnitId,
          effectInstanceId: effect.effectInstanceId,
          update,
        });
      }
    }
  }

  return matched;
}

/**
 * `matchEffectRuntimeCounterUpdates`が確定した1件を、呼び出し時点の`units`に対して
 * 適用する。効果インスタンスが同じバッチの先行ステップで既に失効・除去済みの場合は
 * no-op（`change: undefined`）とする — `duration-expiry-service.ts`の
 * `expireEffects`と同じ「既に取り除かれていれば何もしない」方針（unitそのものが
 * 消える`applyMatchedRuntimeCounterUpdate`の異常系とは異なり、効果インスタンスの
 * 消失は通常のPS連鎖で起こりうる）。
 */
export function applyMatchedEffectRuntimeCounterUpdate(
  matched: MatchedEffectRuntimeCounterUpdate,
  units: readonly BattleUnit[],
  event: TriggerCandidateEvent,
): {
  readonly units: readonly BattleUnit[];
  readonly change: EffectRuntimeCounterUpdateResult | undefined;
} {
  const holder = units.find((u) => u.battleUnitId === matched.battleUnitId);
  if (holder === undefined) {
    throw new DomainValidationError(
      "units",
      `battleUnitId "${matched.battleUnitId}" disappeared while applying counterUpdates`,
    );
  }
  const effect = holder.appliedEffects.find((e) => e.effectInstanceId === matched.effectInstanceId);
  if (effect === undefined) {
    return { units, change: undefined };
  }
  const { update } = matched;
  const existingCounters = effect.duration.counters ?? {};
  const carryBefore = existingCounters[update.counter]?.carry ?? 0;
  const applied = applyUpdate(update, existingCounters, holder, event);

  const updatedHolder: BattleUnit = {
    ...holder,
    appliedEffects: holder.appliedEffects.map((e) =>
      e.effectInstanceId === effect.effectInstanceId
        ? { ...e, duration: { ...e.duration, counters: applied.counters } }
        : e,
    ),
  };
  const nextUnits = units.map((u) =>
    u.battleUnitId === updatedHolder.battleUnitId ? updatedHolder : u,
  );

  const valueChanged = applied.before !== applied.after;
  if (!valueChanged && applied.carry === carryBefore) {
    return { units: nextUnits, change: undefined };
  }
  return {
    units: nextUnits,
    change: {
      battleUnitId: matched.battleUnitId,
      effectInstanceId: matched.effectInstanceId,
      counter: update.counter,
      before: applied.before,
      after: applied.after,
      carry: applied.carry,
      carryBefore,
      valueChanged,
    },
  };
}

/**
 * `matchEffectRuntimeCounterUpdates`＋`applyMatchedEffectRuntimeCounterUpdate`の
 * 単純な合成。`runtime-counter-matcher.ts`の`detectRuntimeCounterUpdates`と同じ役割
 * （PS連鎖の候補解決を挟まず1回で結果がほしい呼び出し側向け）。
 */
export function detectEffectRuntimeCounterUpdates(
  units: readonly BattleUnit[],
  event: TriggerCandidateEvent,
): {
  readonly units: readonly BattleUnit[];
  readonly changes: readonly EffectRuntimeCounterUpdateResult[];
} {
  const matched = matchEffectRuntimeCounterUpdates(units, event);
  const changes: EffectRuntimeCounterUpdateResult[] = [];
  let workingUnits = units;
  for (const entry of matched) {
    const result = applyMatchedEffectRuntimeCounterUpdate(entry, workingUnits, event);
    workingUnits = result.units;
    if (result.change !== undefined) {
      changes.push(result.change);
    }
  }
  return { units: workingUnits, changes };
}
