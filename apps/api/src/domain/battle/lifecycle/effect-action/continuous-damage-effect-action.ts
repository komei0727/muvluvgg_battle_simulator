import { grantEffect } from "../../effects/effect-grant-service.js";
import {
  grantPoisonContinuousDamage,
  isBurnStackLimitReached,
} from "../continuous-damage-service.js";
import { CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY } from "../../model/applied-effect.js";
import { requireUnit } from "../action-resolution-shared.js";
import {
  completeGrant,
  evaluateGrantMagnitude,
  rejectIfImmune,
  skippedOutcome,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import { eventContextOf, findActorUnit, grantSourceOf } from "./effect-action-group-context.js";

/**
 * R-DOT-01〜04（DMG-008）: 付与時点ではダメージを与えず、保持者の`ActionStarted`で
 * `continuous-damage-service.ts`が発生させる継続効果として付与する
 * （`APPLY_CONTINUOUS_HEAL`と同じ構造）。
 *
 * R-DOT-01「付与時に付与者の攻撃力をスナップショットとして記録する」: 付与者の攻撃力を
 * `AppliedEffect.snapshot.sourceAttack`へ焼き込み、以後の攻撃力変化・付与者の戦闘不能に
 * 影響されないようにする。`formula`も`APPLY_STAT_MOD`と同じ評価規約で付与時に一度だけ
 * 評価して`magnitude`へ置く — `FIXED`/`BURN`はこれがそのまま固定ダメージ量になり、
 * `POISON`は発火時点の現在HPを参照し直す必要があるため監査用の付与時snapshotに留まる。
 */
export const resolveApplyContinuousDamage: EffectActionHandler<"APPLY_CONTINUOUS_DAMAGE"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const actor = findActorUnit(context, box);
  const magnitude = evaluateGrantMagnitude(input, effectAction.payload.formula);

  const rejected = rejectIfImmune(input, magnitude);
  if (rejected !== undefined) {
    return rejected;
  }

  // R-DOT-03「最大3つまで保持する」: 上限到達時は付与自体を行わない
  // （`APPLY_STAT_MOD.stacking.max`と同じ「変化が無ければイベントを発行しない」規約。
  // 3つ保持している対象への4つ目は`SKIPPED`になる）。
  if (
    effectAction.payload.continuousDamageKind === "BURN" &&
    isBurnStackLimitReached(requireUnit(box.units, application.targetBattleUnitId))
  ) {
    return skippedOutcome(input);
  }

  const grantContext = eventContextOf(context);
  const grantRequest = {
    definition: effectAction,
    ...grantSourceOf(context),
    targetId: application.targetBattleUnitId,
    duplicate: true,
    magnitude,
    continuousDamage: {
      continuousDamageKind: effectAction.payload.continuousDamageKind,
      damageType: effectAction.payload.damageType,
    },
    durationDefinition: effectAction.payload.duration,
    snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: actor?.combatStats.attack ?? 0 },
  };
  // R-DOT-04「既存の毒へ再付与した場合、…一つの毒を残す」: 毒だけは新規インスタンスを
  // 追加せず既存へ統合する（R-STS-02の気絶と同じ、Q-EFF-10の既定に対する固有規則の上書き）。
  const grantResult =
    effectAction.payload.continuousDamageKind === "POISON"
      ? grantPoisonContinuousDamage(
          grantContext,
          box.units,
          grantRequest,
          context.definitions.effectActions,
          startingEventId,
        )
      : grantEffect(grantContext, box.units, grantRequest, startingEventId);
  // R-DOT-04: 期間も効果量も既存側が勝った再付与は何も変えないため`SKIPPED`。
  const changed = grantResult.lastEventId !== startingEventId;
  return completeGrant(input, grantResult, changed ? "APPLIED" : "SKIPPED");
};
