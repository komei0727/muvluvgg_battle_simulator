import type { AppliedEffect } from "../model/applied-effect.js";
import type { ConsumptionKind } from "../../catalog/definitions/catalog-enums.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";

export interface EffectConsumptionChange {
  readonly effectInstanceId: EffectInstanceId;
  readonly before: number;
  readonly after: number;
}

export interface EffectConsumptionDecrementResult {
  readonly effects: readonly AppliedEffect[];
  readonly changes: readonly EffectConsumptionChange[];
}

/**
 * R-EFF-07: 指定した消費条件`kind`に一致する効果の残り消費回数を1減らす。
 * `effects`は対象1ユニット分（消費条件が成立したイベントのowner）を渡す。
 * `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`/`OUTGOING_HIT`/`INCOMING_HIT`/
 * `STATUS_BLOCKED`/`LETHAL_DAMAGE`のいずれも同じ仕組みで扱う。
 */
export function decrementConsumption(
  effects: readonly AppliedEffect[],
  kind: ConsumptionKind,
): EffectConsumptionDecrementResult {
  const changes: EffectConsumptionChange[] = [];
  const next = effects.map((effect) => {
    const remaining = effect.duration.consumptionRemaining;
    if (
      effect.duration.definition.consumption?.kind !== kind ||
      remaining === undefined ||
      remaining <= 0
    ) {
      return effect;
    }
    const after = remaining - 1;
    changes.push({ effectInstanceId: effect.effectInstanceId, before: remaining, after });
    return { ...effect, duration: { ...effect.duration, consumptionRemaining: after } };
  });
  return { effects: next, changes };
}
