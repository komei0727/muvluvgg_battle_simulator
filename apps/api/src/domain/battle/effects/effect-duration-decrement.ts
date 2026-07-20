import type { AppliedEffect } from "../model/applied-effect.js";
import type { ActionId, EffectInstanceId } from "../../shared/event-ids.js";
import type { DurationTimeUnit } from "../../catalog/definitions/catalog-enums.js";

export interface EffectDurationChange {
  readonly effectInstanceId: EffectInstanceId;
  readonly before: number;
  readonly after: number;
}

export interface EffectDurationDecrementResult {
  readonly effects: readonly AppliedEffect[];
  readonly changes: readonly EffectDurationChange[];
}

function decrementTimeLimitedEffects(
  effects: readonly AppliedEffect[],
  unit: DurationTimeUnit,
  wasGrantedInCurrentScope: (effect: AppliedEffect) => boolean,
): EffectDurationDecrementResult {
  const changes: EffectDurationChange[] = [];
  const next = effects.map((effect) => {
    const remaining = effect.duration.timeLimitRemaining;
    if (
      effect.duration.definition.timeLimit?.unit !== unit ||
      remaining === undefined ||
      remaining <= 0 ||
      wasGrantedInCurrentScope(effect)
    ) {
      return effect;
    }
    const after = remaining - 1;
    changes.push({ effectInstanceId: effect.effectInstanceId, before: remaining, after });
    return { ...effect, duration: { ...effect.duration, timeLimitRemaining: after } };
  });
  return { effects: next, changes };
}

/**
 * R-EFF-04: 対象自身の行動終了時に、その対象へ付与された行動単位効果を1減らす。
 * 付与行動IDが現在の行動IDと同じ効果（今回の行動で付与されたもの）は対象外
 * とする（初回減算除外）。呼び出し側は`effects`にこの対象自身が保持する
 * `AppliedEffect`だけを渡す（`decrementActionCooldowns`と同じ形）。
 *
 * `DurationOwner`（`EFFECT_TARGET`/`EFFECT_SOURCE`/`BATTLE`）による付与者側
 * 相対タイミングは区別しない — 常に保持者自身の行動終了時に減算する。これを
 * 必要とする具体的なCatalog行が現れるまでの意図的な単純化（`RuntimeCounter`の
 * Battle/BattleUnitスコープをIssue #149へ委ねたのと同じ方針）。
 */
export function decrementActionEffectDurations(
  effects: readonly AppliedEffect[],
  currentActionId: ActionId,
): EffectDurationDecrementResult {
  return decrementTimeLimitedEffects(
    effects,
    "ACTION",
    (effect) => effect.duration.grantedActionId === currentActionId,
  );
}

/**
 * R-EFF-06: ターン終了時にターン単位効果を1減らす。付与ターン番号が現在の
 * ターン番号と同じ効果（今回のターンで付与されたもの）は対象外とする
 * （初回減算除外）。
 */
export function decrementTurnEffectDurations(
  effects: readonly AppliedEffect[],
  currentTurnNumber: number,
): EffectDurationDecrementResult {
  return decrementTimeLimitedEffects(
    effects,
    "TURN",
    (effect) => effect.duration.grantedTurnNumber === currentTurnNumber,
  );
}
