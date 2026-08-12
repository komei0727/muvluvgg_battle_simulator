import { grantEffect } from "../../effects/effect-grant-service.js";
import {
  completeGrant,
  evaluateGrantMagnitude,
  rejectIfImmune,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import { eventContextOf, grantSourceOf } from "./effect-action-group-context.js";

/**
 * 付与時点でFormulaを一度だけ評価し、その結果を`AppliedEffect.magnitude`として
 * 保持する補正系の継続効果（R-ACTN-03）。実際の適用はそれぞれの消費側が行うため、
 * CombatStatsを変更せず`combat-stat-recalculation-service.ts`も呼ばない
 * （`APPLY_STAT_MOD`/`MODIFY_RESOURCE_CAPACITY`との違い）。
 *
 * - `APPLY_HEALING_MOD`（R-HEAL-02）: 符号付き割合の回復量補正。実際の適用は
 *   `heal-application-service.ts`が`composeHealingRate`で合成する。
 * - `APPLY_DAMAGE_MOD`（R-DMG-04、DMG-002）: 符号付き割合の与/被ダメージ補正。向き・対象
 *   ダメージタイプ・動的条件（`DYNAMIC_DAMAGE_MOD_CONDITION`）は
 *   `AppliedEffect.damageModifier`へ焼き込み、実際の集計は
 *   `combat/damage-modifier-policy.ts`がヒットごとに行う（条件は付与時ではなく
 *   ヒット時点の状態で評価する必要があるため、`magnitude`と違ってsnapshotにできない）。
 * - `APPLY_CONTINUOUS_HEAL`（R-HEAL-03）: 付与時点では回復せず、`timing.eventType`が
 *   発生した時点で`continuous-heal-service.ts`がR-HEAL-01と同じ手順で回復する。
 *   回復量Formulaは発火のたびに評価し直す必要がある（`MAX_HP_RATIO`/`MISSING_HP_RATIO`が
 *   発火時点の対象HPを参照するため）ので、ここで評価した`magnitude`は監査用の
 *   付与時snapshotに留める。
 */
export const resolveContinuousModifier: EffectActionHandler<
  "APPLY_HEALING_MOD" | "APPLY_DAMAGE_MOD" | "APPLY_CONTINUOUS_HEAL"
> = (input): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const magnitude = evaluateGrantMagnitude(input, effectAction.payload.formula);
  const rejected = rejectIfImmune(input, magnitude);
  if (rejected !== undefined) {
    return rejected;
  }
  return completeGrant(
    input,
    grantEffect(
      eventContextOf(context),
      box.units,
      {
        definition: effectAction,
        ...grantSourceOf(context),
        targetUnitId: application.targetUnitId,
        duplicate: true,
        magnitude,
        ...(effectAction.kind === "APPLY_DAMAGE_MOD"
          ? {
              damageModifier: {
                direction: effectAction.payload.direction,
                damageType: effectAction.payload.damageType,
                ...(effectAction.payload.condition !== undefined
                  ? { condition: effectAction.payload.condition }
                  : {}),
                ...(effectAction.payload.damageThreshold !== undefined
                  ? { damageThreshold: effectAction.payload.damageThreshold }
                  : {}),
              },
            }
          : {}),
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};

/**
 * ON_ATTACK_BONUS_DAMAGE_BUFF（M7-004、production例:
 * SKL_ELENA_MOODMAKER_EXの「攻撃時に攻撃力×15%のダメージを追加するバフ」）:
 * `APPLY_STAT_MOD`と同じ評価規約で`formula`を付与時点に一度だけ評価し、結果を
 * `magnitude`（`AppliedEffect.isAttackDamageBonus: true`）として保持する。
 * 動的な毎ヒット再評価ではなく付与時snapshot — `damage-application-service.ts`は
 * Catalogを引けないため、判定に必要な値はすべて付与時点で`AppliedEffect`自身へ
 * 焼き込む（`resolveDamageImmunity`/`resolveDarkness`と同じ理由）。
 */
export const resolveApplyAttackDamageBonus: EffectActionHandler<"APPLY_ATTACK_DAMAGE_BONUS"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const magnitude = evaluateGrantMagnitude(input, effectAction.payload.formula);
  const rejected = rejectIfImmune(input, magnitude);
  if (rejected !== undefined) {
    return rejected;
  }
  return completeGrant(
    input,
    grantEffect(
      eventContextOf(context),
      box.units,
      {
        definition: effectAction,
        ...grantSourceOf(context),
        targetUnitId: application.targetUnitId,
        duplicate: true,
        magnitude,
        isAttackDamageBonus: true,
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};

/**
 * R-DMG-03（`TEMP_PIERCING_GRANT`、DMG-003）: 保持者が行う後続の
 * 攻撃へ一時的に防御貫通を上乗せする継続効果（R-ACTN-03）。3つの率は静的な
 * Catalog値のため`formula`を持たず、`magnitude`は使わない（0のまま）——
 * 1インスタンスが独立した3つの率を同時に持ちうるため、単一のスカラーへ
 * 畳み込めないためである。実際の合成は`combat/piercing-policy.ts`が
 * ヒットごとに行う（`APPLY_DAMAGE_MOD`と同じ責務分割）。
 */
export const resolveApplyPiercingMod: EffectActionHandler<"APPLY_PIERCING_MOD"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const rejected = rejectIfImmune(input, 0);
  if (rejected !== undefined) {
    return rejected;
  }
  return completeGrant(
    input,
    grantEffect(
      eventContextOf(context),
      box.units,
      {
        definition: effectAction,
        ...grantSourceOf(context),
        targetUnitId: application.targetUnitId,
        duplicate: true,
        magnitude: 0,
        piercing: {
          defenseIgnoreRate: effectAction.payload.defenseIgnoreRate,
          shieldIgnoreRate: effectAction.payload.shieldIgnoreRate,
          damageReductionIgnoreRate: effectAction.payload.damageReductionIgnoreRate,
        },
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};
