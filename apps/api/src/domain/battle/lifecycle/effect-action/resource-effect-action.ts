import { grantEffect } from "../../effects/effect-grant-service.js";
import { recalculateCombatStatsSteps } from "../../effects/combat-stat-recalculation-service.js";
import { applyModifyResourceActionSteps } from "../resource-modification-service.js";
import {
  completeGrant,
  driveRemovalSteps,
  evaluateGrantMagnitude,
  rejectIfImmune,
  type EffectActionHandler,
  type EffectActionOutcome,
  type SteppedEffectActionHandler,
} from "./effect-action-handler.js";
import { eventContextOf, grantSourceOf, requireActorUnit } from "./effect-action-group-context.js";

/**
 * R-ACTN-02＋M7-002（HP_DIRECT_COST）: AP/PP/EX_GAUGEの一回限りの加減算に加え、
 * `resource: HP`で防御力・会心などの通常ダメージ処理を経由せずHPを直接増減する
 * （`UNIT_SUIRAN_CASINO`等の自己コスト）。
 *
 * M7-017（`CAP_RESOURCE_DISTRIBUTE`）: `operation: DISTRIBUTE`は`HEAL`の
 * `distribution: "EVEN"`と同じ`distributionShareCount`（同一EffectStep内でこの
 * EffectActionが実際に適用される対象数、`resolveActionApplications`が算出）で
 * 総量を等分する。
 */
/**
 * R-TEX-03 #2: 演習で敵のHPが0へ落ちるとブレイク解決がこのEffectActionの内側で
 * 連鎖境界を作る（撃破トリガーを解除より前に完了させる必要がある）ため、DAMAGE・
 * HEALと同じstepped handlerにして`driveRemovalSteps`へ委譲する。通常戦闘では
 * generatorが一度も`yield`しないため、従来と同じ一括解決のままである。
 */
export const resolveModifyResource: SteppedEffectActionHandler<"MODIFY_RESOURCE"> = function* (
  input,
) {
  const { context, box, application, effectAction, startingEventId, distributionShareCount } =
    input;
  const actor = requireActorUnit(context, box);
  const modifyResult = yield* driveRemovalSteps(
    input,
    applyModifyResourceActionSteps(
      application.hits,
      actor,
      effectAction,
      box.units,
      {
        ...eventContextOf(context),
        parentEventId: startingEventId,
        // COOLDOWN_MANIPULATION/MODIFY_RESOURCE/HEALは発生源ユニットを前提とする
        // （`CooldownManipulationEventContext`等の`sourceUnitId`は必須）。
        // Memory由来の解決はR-MEM-04に従って拒否する。
        sourceUnitId: actor.battleUnitId,
        ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
        ...(context.onFactEventForPassiveChain !== undefined
          ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
          : {}),
      },
      distributionShareCount,
    ),
  );
  box.units = modifyResult.units;
  return {
    resultKind: modifyResult.changed ? "APPLIED" : "SKIPPED",
    resolvedCount: modifyResult.resolvedCount,
    interruptedCount: 0,
    criticalHitCount: 0,
    lastEventId: modifyResult.lastEventId,
  };
};

/**
 * G-09（`14_Catalog定義スキーマ.md`「MODIFY_RESOURCE_CAPACITY」、M7-002A、
 * `CAP_RESOURCE_CAPACITY_MOD`）: `MODIFY_RESOURCE`が現在値の一回限りの加減算で
 * あるのに対し、こちらは**上限そのもの**を`duration`の間変える継続効果（R-ACTN-03）。
 * `APPLY_STAT_MOD`と同じ評価規約で`formula`を付与時点に一度だけ評価し、結果を
 * `magnitude`へ保持したうえで、`recalculateCombatStats`（R-STA-04の再計算フック）が
 * `baseMaximum*`から上限を再合成する（`resource-capacity-recalculation-service.ts`）。
 * 失効・解除時も同じフックを通るため、上限は明示的な巻き戻し処理なしに基準へ戻る。
 *
 * `payload`に`stacking`を持たないため、`APPLY_RESOURCE_GAIN_MOD`と同じく常に
 * 重複あり（`duplicate: true`）で付与する。
 */
export const resolveModifyResourceCapacity: SteppedEffectActionHandler<"MODIFY_RESOURCE_CAPACITY"> =
  function* (input) {
    const { context, box, application, effectAction, startingEventId } = input;
    const magnitude = evaluateGrantMagnitude(input, effectAction.payload.formula);
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
        duplicate: true,
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

/**
 * G-05（`14_Catalog定義スキーマ.md`、M7-002）: `APPLY_STAT_MOD`と同じ評価規約で
 * `rateDelta`を付与時点に一度だけ評価し、結果を符号付き倍率として`magnitude`へ保持する。
 * EXゲージ増加量への実際の適用は`action-resolution-shared.ts`の`increaseExGauge`
 * 呼び出し側（`resource-gain-mod-composition.ts`が対象の有効なAppliedEffectを合成）が
 * 行うため、ここではCombatStatsと同様の再計算は不要。
 */
export const resolveApplyResourceGainMod: EffectActionHandler<"APPLY_RESOURCE_GAIN_MOD"> = (
  input,
): EffectActionOutcome => {
  const { context, box, application, effectAction, startingEventId } = input;
  const magnitude = evaluateGrantMagnitude(input, effectAction.payload.rateDelta);
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
        durationDefinition: effectAction.payload.duration,
      },
      startingEventId,
    ),
  );
};
