import { grantEffect, isStackLimitReached } from "../../effects/effect-grant-service.js";
import { recalculateCombatStatsSteps } from "../../effects/combat-stat-recalculation-service.js";
import { evaluateFormula } from "../../skill/formula-evaluator.js";
import { requireUnit } from "../action-resolution-shared.js";
import {
  completeGrant,
  driveRemovalSteps,
  grantFormulaScope,
  rejectIfImmune,
  skippedOutcome,
  type SteppedEffectActionHandler,
} from "./effect-action-handler.js";
import { eventContextOf, grantSourceOf } from "./effect-action-group-context.js";

/**
 * R-EFF-01: 継続stat補正を`AppliedEffect`として個別に付与する（レジストリ追加・
 * `EffectApplied`・StateDelta・独立Reducer復元まで）。重複あり・重複なしは
 * `stacking.mode`（M7-012でCatalogスキーマへ`NON_STACKABLE`を追加）から`duplicate`へ
 * そのまま写す。
 *
 * R-EFF-05/R-STA-02〜04: 付与直後にCombatStatを再計算し、実際に変化したstatごとに
 * `CombatStatChanged`を、重複なしグループの採用対象が変わった場合は
 * `EffectiveEffectChanged`も発行する（`combat-stat-recalculation-service.ts`）。
 *
 * R-NUM-04: `triggerSource`/`triggerTarget`はRES-005が`context.triggerSourceUnitId`/
 * `triggerTargetUnitIds`から配線する（`TRIGGER_TARGET`は複数ユニットを指しうるが、
 * Formula側は単一参照のため先頭の1体を使う、R-TGT-10と同じ規約）。IDのままここまで運び、
 * 評価するこの瞬間の`box.units`から引き直す — PS開始時に一度だけ解決した`BattleUnit`を
 * 保持すると、先行するEffectActionや子PS連鎖による対象のHP・combatStats変更をこの
 * Formulaが見落としてしまうため。`bindings`はこの呼び出し元では引き続き用意できず、
 * それを要求するFormulaは`FormulaEvaluator`が明確な例外で拒否する。
 */
/**
 * R-TEX-03 #2: `APPLY_STAT_MOD(MAXIMUM_HP)`の付与・失効はHP上限を動かし、演習では
 * 敵のHPを0へ切り下げてブレイクを起こしうる。その撃破トリガーを解除より前に
 * 完了させるため、再計算をstepped handlerとして`driveRemovalSteps`へ委譲する
 * （通常戦闘では一度も`yield`せず従来と同じ一括解決）。
 */
export const resolveApplyStatMod: SteppedEffectActionHandler<"APPLY_STAT_MOD"> = function* (input) {
  const { context, box, application, effectAction, startingEventId } = input;

  // R-EFF-05「重複上限」（`STACK_LIMIT_ON_STAT_MOD`、M7-012）: 対象が同じ
  // `EffectKindKey`のインスタンスを`stacking.max`件保持している場合、新規インスタンスを
  // 追加しない（`EffectApplied`もCombatStat再計算も行わず、`EffectActionCompleted.
  // resultKind: SKIPPED`だけを記録する）。
  //
  // 免疫判定（R-EFF-03）より前に評価する — `rejectEffectApplication`は
  // `EFFECT_IMMUNITY`の`blockedCount`を1消費するため、そもそも1件も追加できない付与で
  // その有限な回数を使わせてはならない。Formula評価も同じ理由でここでは行わない
  // （付与しない値を計算しても捨てるだけ）。
  if (
    isStackLimitReached(
      requireUnit(box.units, application.targetUnitId),
      effectAction,
      effectAction.payload.stacking.max,
    )
  ) {
    return skippedOutcome(input);
  }

  const triggerTargetUnitId = context.triggerTargetUnitIds?.[0];
  const magnitude = evaluateFormula(effectAction.payload.formula, {
    ...grantFormulaScope(input),
    ...(context.triggerSourceUnitId !== undefined
      ? { triggerSource: requireUnit(box.units, context.triggerSourceUnitId) }
      : {}),
    ...(triggerTargetUnitId !== undefined
      ? { triggerTarget: requireUnit(box.units, triggerTargetUnitId) }
      : {}),
  });

  const rejected = rejectIfImmune(input, magnitude);
  if (rejected !== undefined) {
    return rejected;
  }

  const beforeGrantUnits = box.units;
  const grantResult = grantEffect(
    eventContextOf(context),
    box.units,
    {
      definition: effectAction,
      ...grantSourceOf(context),
      targetUnitId: application.targetUnitId,
      duplicate: effectAction.payload.stacking.mode === "STACKABLE",
      magnitude,
      durationDefinition: effectAction.payload.duration,
    },
    startingEventId,
  );
  box.units = grantResult.units;
  return completeGrant(
    input,
    yield* driveRemovalSteps(
      input,
      recalculateCombatStatsSteps(
        eventContextOf(context),
        beforeGrantUnits,
        box.units,
        application.targetUnitId,
        context.definitions.effectActions,
        grantResult.lastEventId,
        "EFFECT_APPLIED",
      ),
    ),
  );
};
