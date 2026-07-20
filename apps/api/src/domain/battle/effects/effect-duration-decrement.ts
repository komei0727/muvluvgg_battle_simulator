import type { AppliedEffect } from "../model/applied-effect.js";
import type { ActionId, EffectInstanceId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";
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

/**
 * PR #155レビュー[P1]: `DurationOwner`（`EFFECT_TARGET`/`EFFECT_SOURCE`/
 * `BATTLE`）がACTION単位減算のtrigger対象ユニットを決める。`EFFECT_SOURCE`/
 * `BATTLE`はproduction Catalogに実例がある（`UNIT_SENKA_CHRISTMAS`等の
 * `EFFECT_SOURCE`、`UNIT_KARINA_DOWNER`の`BATTLE`）。`BATTLE`は保持者・付与者を
 * 問わず戦闘内のどのユニットの行動終了でも1減らす（「次の1行動だけ」を表現する
 * ための、特定ユニットに縛られない全体トリガー）。
 */
function actionOwnerTriggerMatches(effect: AppliedEffect, actingUnitId: BattleUnitId): boolean {
  const owner = effect.duration.definition.timeLimit?.owner ?? "EFFECT_TARGET";
  if (owner === "EFFECT_SOURCE") {
    return effect.sourceId === actingUnitId;
  }
  if (owner === "BATTLE") {
    return true;
  }
  return effect.targetId === actingUnitId;
}

function decrementTimeLimitedEffects(
  effects: readonly AppliedEffect[],
  unit: DurationTimeUnit,
  wasGrantedInCurrentScope: (effect: AppliedEffect) => boolean,
  triggersFor: (effect: AppliedEffect) => boolean,
): EffectDurationDecrementResult {
  const changes: EffectDurationChange[] = [];
  const next = effects.map((effect) => {
    const remaining = effect.duration.timeLimitRemaining;
    if (
      effect.duration.definition.timeLimit?.unit !== unit ||
      remaining === undefined ||
      remaining <= 0 ||
      wasGrantedInCurrentScope(effect) ||
      !triggersFor(effect)
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
 * R-EFF-04: `actingUnitId`の行動終了時に、`timeLimit.owner`が指す対象
 * （既定は保持者自身=`EFFECT_TARGET`、`EFFECT_SOURCE`は付与者、`BATTLE`は
 * どのユニットでも）と一致する行動単位効果を1減らす。付与行動IDが現在の
 * 行動IDと同じ効果（今回の行動で付与されたもの）は対象外とする
 * （初回減算除外）。呼び出し側は`effects`に対象となりうる保持者1ユニット分の
 * `AppliedEffect`を渡す（`decrementActionCooldowns`と同じ形）。
 */
export function decrementActionEffectDurations(
  effects: readonly AppliedEffect[],
  currentActionId: ActionId,
  actingUnitId: BattleUnitId,
): EffectDurationDecrementResult {
  return decrementTimeLimitedEffects(
    effects,
    "ACTION",
    (effect) => effect.duration.grantedActionId === currentActionId,
    (effect) => actionOwnerTriggerMatches(effect, actingUnitId),
  );
}

/**
 * R-EFF-06: ターン終了時にターン単位効果を1減らす。付与ターン番号が現在の
 * ターン番号と同じ効果（今回のターンで付与されたもの）は対象外とする
 * （初回減算除外）。ターンは全ユニット共通の単一クロックのため、`owner`による
 * trigger対象ユニットの区別は不要（誰の行動でも同時にターンが終わる）。
 */
export function decrementTurnEffectDurations(
  effects: readonly AppliedEffect[],
  currentTurnNumber: number,
): EffectDurationDecrementResult {
  return decrementTimeLimitedEffects(
    effects,
    "TURN",
    (effect) => effect.duration.grantedTurnNumber === currentTurnNumber,
    () => true,
  );
}
