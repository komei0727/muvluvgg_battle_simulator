import { grantEffect } from "../../effects/effect-grant-service.js";
import { SUBUNIT_PROVIDER_ATTACK_KEY } from "../../model/applied-effect.js";
import { truncateFraction } from "../../model/resource-gauge.js";
import {
  completeGrant,
  evaluateGrantMagnitude,
  rejectIfImmune,
  type EffectActionHandler,
  type EffectActionOutcome,
} from "./effect-action-handler.js";
import { eventContextOf, findActorUnit, grantSourceOf } from "./effect-action-group-context.js";

/**
 * R-SHD-01（DMG-004）: HPとは別枠の吸収プールを`AppliedEffect`として付与する
 * （R-ACTN-03）。`APPLY_STAT_MOD`と同じ評価規約で`formula`を付与時点に一度だけ評価し、
 * R-NUM-02「シールド付与量は適用直前に小数部分を切り捨てる」に従って整数化した値を
 * 最大値（`magnitude`）と初期残量（`shield.remaining`）の両方に置く。負のFormula結果は
 * 吸収プールとして意味を持たないため0へ丸める（`heal-application-service.ts`の
 * R-HEAL-01 #5と同じ規約）。
 *
 * 重複規則はR-EFF-01の一般規則どおり常に新規インスタンス（`duplicate: true`）—
 * R-SHD-01「同じタイプのシールド付与値を加算する」はプール合計側の規則であり、
 * インスタンスの統合ではない。CombatStatsには影響しないため再計算は呼ばない。
 *
 * R-SHD-01第3項: Formula結果が負値・0、または切り捨てで0になった付与は残量0の
 * インスタンスとして永続してしまう（吸収も漸減も`remaining <= 0`を対象外にするため、
 * 期間満了まで枯渇契機が訪れない）。「残量が0になったインスタンスは即時失効させる」に
 * 従って失効させるが、実際の失効はこのEffectActionの中では行わず、EffectSequence解決の
 * 最後（`sweepDepletedShields`）まで遅らせる。次の2点による。
 *
 * - この時点ではまだ同じACTION stepの後続EffectActionが付与するCHILDが存在せず、
 *   R-EFF-09のカスケードで収集できない（production例: `SKL_LILY_SINGER_PS2`は
 *   `SHIELD`(PARENT)→`ATK_UP`(CHILD)の定義順）。ここで失効させると、後から付与された
 *   CHILDだけがグループの親を失って残る
 * - PS/Memory自身のEffectSequence解決（`onFactEventForPassiveChain`未指定）では
 *   `EffectApplied`をdriverへ`yield`する前に同期失効まで進んでしまい、`EffectApplied`を
 *   契機とするPS/Memoryが付与直後の状態を観測できない
 */
export const resolveApplyShield: EffectActionHandler<"APPLY_SHIELD"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const magnitude = Math.max(
    0,
    truncateFraction(evaluateGrantMagnitude(input, effectAction.payload.formula)),
  );
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
        targetId: application.targetBattleUnitId,
        duplicate: true,
        magnitude,
        shield: {
          shieldType: effectAction.payload.shieldType ?? null,
          remaining: magnitude,
          ...(effectAction.payload.decay !== undefined
            ? { decay: effectAction.payload.decay }
            : {}),
        },
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};

/**
 * R-SUB-01/02（DMG-005）: HPともシールドとも別枠の耐久力を持つサブユニットを
 * `AppliedEffect`として付与する。`APPLY_SHIELD`とまったく同じ評価・重複規約に従う —
 * `durability.formula`を付与時点に一度だけ評価し、R-NUM-02どおり切り捨てた値を
 * 最大耐久力（`magnitude`）と初期残耐久力（`subUnit.durability`）の両方に置き、負の結果は
 * 0へ丸める。重複規則はR-EFF-01の一般規則どおり常に新規インスタンス（`duplicate: true`）で、
 * production定義も同じサブユニットを3つ付与する（`SKL_OLGA_VETERAN_PS1`）。
 *
 * R-SUB-02: 追加ダメージの`providerAttack: SOURCE_SNAPSHOT_ATTACK`が参照する付与者の
 * 攻撃力を、継続ダメージ（R-DOT-01）と同じ`AppliedEffect.snapshot`へ焼き込む。付与者は
 * サブユニットの所持者と別のユニットになり得る（`SKL_SHIRANA_SORA_EX`は味方へ付与する）
 * ため、所持者の現在攻撃力（`ownerAttack: CURRENT_ATTACK`）とは独立に保持する必要がある。
 *
 * R-SUB-01: 耐久力0で付与されたインスタンスは、シールドとまったく同じ理由・同じ
 * タイミング（EffectSequence解決の最後、`sweepDepletedShields`）で失効させる。
 */
export const resolveApplySubUnit: EffectActionHandler<"APPLY_SUBUNIT"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const actor = findActorUnit(context, box);
  const magnitude = Math.max(
    0,
    truncateFraction(evaluateGrantMagnitude(input, effectAction.payload.durability.formula)),
  );
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
        targetId: application.targetBattleUnitId,
        duplicate: true,
        magnitude,
        subUnit: {
          durability: magnitude,
          additionalDamage: effectAction.payload.additionalDamage,
        },
        snapshot: { [SUBUNIT_PROVIDER_ATTACK_KEY]: actor?.combatStats.attack ?? 0 },
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};
