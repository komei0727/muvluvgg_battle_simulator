import { applyFollowUpAttacksSteps, type FollowUpAttackRider } from "../combat/follow-up-attack.js";
import { driveRemovalSteps } from "../combat/damage-hit-chain.js";
import type {
  DamageEventContext,
  FollowUpAttackCapture,
} from "../combat/damage-application-service.js";
import { grantEffect } from "../effects/effect-grant-service.js";
import {
  findBlockingImmunity,
  rejectEffectApplication,
} from "../effects/effect-immunity-service.js";
import { recalculateCombatStatsSteps } from "../effects/combat-stat-recalculation-service.js";
import { expireEffectsSteps } from "../effects/duration-expiry-service.js";
import { grantPoisonContinuousDamage } from "./continuous-damage-service.js";
import { CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY } from "../model/applied-effect.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { requireUnit } from "./action-resolution-shared.js";
import {
  applyDeathSurvivalHealSteps,
  type DamageHookSteps,
} from "./effect-action/damage-effect-action.js";
import { buildConsumeEffectDurationHooks } from "./effect-action/effect-duration-consumption.js";
import {
  eventContextOf,
  requireSkillDefinitionId,
  skillTypeOf,
  type EffectActionGroupContext,
} from "./effect-action/effect-action-group-context.js";
import { evaluateFormula, damageResultsFor } from "../skill/formula-evaluator.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * R-FUP-01第3項（Issue #474）: 追撃ヒットが適用された対象へonHitEffectを付与する。
 *
 * 参照先が`APPLY_STAT_MOD`または`APPLY_CONTINUOUS_DAMAGE`であることは
 * `catalog-integrity.ts`がCatalogロード時点で保証する（production例:
 * `SKL_SUIRAN_CHAOS_PS3`の行動速度-200、`SKL_CHIYURU_MAZE_PS2`の毒3行動）。
 * 付与そのものは各kindの通常解決と同じ経路（`EffectApplied`・CombatStat再計算・
 * R-DOT-04の毒統合・R-EFF-03の免疫判定）を通る — onHitEffectだけが別のライフサイクルを
 * 持たないようにするためである（`grantSubUnitAdditionalDamageDebuffSteps`と同じ方針）。
 *
 * 付与の帰属先（`sourceUnitId`）はライダーを付与したユニット（`riderSourceUnitId`）
 * とし、不明な場合だけ攻撃者へフォールバックする。Formula評価の`SKILL_SOURCE`は
 * 攻撃者（追撃ヒットを届けた本人）で評価する — 追撃のダメージ計算と同じ
 * 「ステータスは攻撃した味方を参照する」規約に揃える。
 */
function* grantFollowUpOnHitEffectSteps(
  context: EffectActionGroupContext,
  units: readonly BattleUnit[],
  targetUnitId: BattleUnitId,
  onHitEffectActionDefinitionId: EffectActionDefinitionId,
  attackerUnitId: BattleUnitId,
  riderSourceUnitId: BattleUnitId | undefined,
  parentEventId: DomainEventId,
): DamageHookSteps {
  const definition = context.definitions.effectActions.get(onHitEffectActionDefinitionId);
  if (
    definition === undefined ||
    (definition.kind !== "APPLY_STAT_MOD" && definition.kind !== "APPLY_CONTINUOUS_DAMAGE")
  ) {
    throw new DomainValidationError(
      "onHitEffect.effectActionDefinitionId",
      `references "${onHitEffectActionDefinitionId}", which must be an APPLY_STAT_MOD or APPLY_CONTINUOUS_DAMAGE EffectActionDefinition present in the Catalog (catalog-integrity.ts rejects anything else at load time)`,
    );
  }
  const eventContext = eventContextOf(context);
  const eventsStart = context.recorder.getEvents().length;
  const attacker = requireUnit(units, attackerUnitId);
  const target = requireUnit(units, targetUnitId);
  const sourceUnitId = riderSourceUnitId ?? attackerUnitId;
  const magnitude = evaluateFormula(definition.payload.formula, {
    skillSource: attacker,
    target,
    allUnits: units,
    lastResults: damageResultsFor(context.damageResults, attackerUnitId, context.skillUseId),
  });
  const blockingImmunity = findBlockingImmunity(
    target,
    { effectActionDefinitionId: onHitEffectActionDefinitionId, magnitude },
    definition,
  );
  if (blockingImmunity !== undefined) {
    const rejection = rejectEffectApplication(
      eventContext,
      units,
      {
        effectActionDefinitionId: onHitEffectActionDefinitionId,
        sourceUnitId,
        targetUnitId,
        blockingEffect: blockingImmunity,
      },
      parentEventId,
    );
    const injected = yield {
      events: context.recorder.getEvents().slice(eventsStart),
      units: rejection.units,
    };
    return { units: injected ?? rejection.units, lastEventId: rejection.lastEventId };
  }
  const grantResult =
    definition.kind === "APPLY_STAT_MOD"
      ? grantEffect(
          eventContext,
          units,
          {
            definition,
            sourceUnitId,
            targetUnitId,
            duplicate: definition.payload.stacking.mode === "STACKABLE",
            magnitude,
            durationDefinition: definition.payload.duration,
          },
          parentEventId,
        )
      : (() => {
          // R-DOT-01「付与時に付与者の攻撃力をスナップショットとして記録する」:
          // 追撃の付随効果もダメージ計算と同じく攻撃者のステータスを参照する。
          const grantRequest = {
            definition,
            sourceUnitId,
            targetUnitId,
            duplicate: true,
            magnitude,
            continuousDamage: {
              continuousDamageKind: definition.payload.continuousDamageKind,
              damageType: definition.payload.damageType,
            },
            durationDefinition: definition.payload.duration,
            snapshot: { [CONTINUOUS_DAMAGE_SOURCE_ATTACK_KEY]: attacker.combatStats.attack },
          };
          // R-DOT-04: 毒だけは新規インスタンスを追加せず既存へ統合する（通常付与と同じ）。
          return definition.payload.continuousDamageKind === "POISON"
            ? grantPoisonContinuousDamage(
                eventContext,
                units,
                grantRequest,
                context.definitions.effectActions,
                parentEventId,
              )
            : grantEffect(eventContext, units, grantRequest, parentEventId);
        })();
  // R-TEX-03 #2: 再計算の中間stepを連鎖driverへ返す（`grantSubUnitAdditionalDamageDebuffSteps`
  // と同じ理由 — 同期wrapperでまとめると演習ブレイクの解決順が逆転する）。
  let cursor = eventsStart;
  const recalculationSteps = recalculateCombatStatsSteps(
    eventContext,
    units,
    grantResult.units,
    targetUnitId,
    context.definitions.effectActions,
    grantResult.lastEventId,
    "EFFECT_APPLIED",
  );
  let step = recalculationSteps.next();
  while (!step.done) {
    const injectedMidway = yield {
      events: context.recorder.getEvents().slice(cursor),
      units: step.value.units,
    };
    cursor = context.recorder.getEvents().length;
    step = recalculationSteps.next(injectedMidway ?? step.value.units);
  }
  const injected = yield {
    events: context.recorder.getEvents().slice(cursor),
    units: step.value.units,
  };
  return { units: injected ?? step.value.units, lastEventId: step.value.lastEventId };
}

/**
 * R-FUP-01（Issue #474）: AS/EXスキル使用の全step解決後・`SkillUseCompleted`発行前に
 * 1回だけ、捕捉済みライダーの追撃を解決する。
 *
 * - `capture.anyApplied`が偽（元攻撃が1発も命中しなかった・攻撃を含まないスキル）なら
 *   追撃自体を行わない（ライダーの消費はヒット観測時点で既に済んでいる）
 * - ライダーの`AppliedEffect`はスキル途中で失効済みのため、`effectActionDefinitionId`
 *   からCatalog定義を引き直して解決素材（`FollowUpAttackRider`）を組む
 * - 会心は元攻撃の`capture.anyCritical`から継承し、命中は必中として扱う（追撃側は
 *   どちらの判定も行わず乱数を消費しない）
 */
export function resolveFollowUpAttacksAfterSkillUse(
  context: EffectActionGroupContext,
  capture: FollowUpAttackCapture,
  units: readonly BattleUnit[],
  parentEventId: DomainEventId,
): { readonly units: readonly BattleUnit[]; readonly lastEventId: DomainEventId } {
  if (capture.riders.size === 0 || !capture.anyApplied || context.actorUnitId === undefined) {
    return { units, lastEventId: parentEventId };
  }
  const actor = units.find((unit) => unit.battleUnitId === context.actorUnitId);
  if (actor === undefined || isDefeated(actor)) {
    // R-SKL-01: 使用者が既に戦闘不能なら追撃も行わない（中断経路はここへ到達しない）。
    return { units, lastEventId: parentEventId };
  }
  const riders: FollowUpAttackRider[] = [];
  for (const [, captured] of capture.riders) {
    const definition = context.definitions.effectActions.get(captured.effectActionDefinitionId);
    if (definition === undefined || definition.kind !== "APPLY_FOLLOW_UP_ATTACK") {
      // Catalogを経由した付与では起こり得ない（`isFollowUpAttack`は
      // `resolveApplyFollowUpAttack`だけが立てる）。合成された状態への防御的スキップ。
      continue;
    }
    riders.push({
      effectActionDefinitionId: captured.effectActionDefinitionId,
      ...(captured.sourceUnitId !== undefined ? { sourceUnitId: captured.sourceUnitId } : {}),
      damageType: definition.payload.damage.damageType,
      formula: definition.payload.damage.formula,
      ...(definition.payload.onHitEffect !== undefined
        ? { onHitEffectActionDefinitionId: definition.payload.onHitEffect.effectActionDefinitionId }
        : {}),
    });
  }
  if (riders.length === 0) {
    return { units, lastEventId: parentEventId };
  }

  const { consumeEffectDuration, finalizeConsumedEffectDurations } =
    buildConsumeEffectDurationHooks(context);
  const skillType = skillTypeOf(context);
  const damageContext: DamageEventContext = {
    ...eventContextOf(context),
    parentEventId,
    skillDefinitionId: requireSkillDefinitionId(context),
    ...(skillType !== undefined ? { skillType } : {}),
    consumeEffectDuration,
    finalizeConsumedEffectDurations,
    // R-SHD-01第3項＋R-SUB-01: 追撃ヒットが枯渇させたシールド・サブユニットの失効も
    // 通常ヒットと同じ経路（`expireEffectsSteps`のR-EFF-09カスケード）をたどる。
    expireDepletedAbsorbers: (
      targetUnitId,
      depletedEffectInstanceIds,
      reason,
      unitsForExpiry,
      expiryParentEventId,
    ) =>
      expireEffectsSteps(
        eventContextOf(context),
        unitsForExpiry,
        depletedEffectInstanceIds.map((effectInstanceId) => ({
          battleUnitId: targetUnitId,
          effectInstanceId,
          reason,
        })),
        context.definitions.effectActions,
        expiryParentEventId,
      ),
    applyDeathSurvivalHeal: (
      targetUnitId,
      effectActionDefinitionId,
      formula,
      unitsForHeal,
      healParentEventId,
    ) =>
      applyDeathSurvivalHealSteps(
        context,
        unitsForHeal,
        targetUnitId,
        effectActionDefinitionId,
        formula,
        healParentEventId,
      ),
    grantFollowUpOnHitEffect: (
      targetUnitId,
      onHitEffectActionDefinitionId,
      attackerUnitId,
      sourceUnitId,
      unitsForGrant,
      grantParentEventId,
    ) =>
      grantFollowUpOnHitEffectSteps(
        context,
        unitsForGrant,
        targetUnitId,
        onHitEffectActionDefinitionId,
        attackerUnitId,
        sourceUnitId,
        grantParentEventId,
      ),
    ...(context.onFactEventForPassiveChain !== undefined
      ? { onFactEventForPassiveChain: context.onFactEventForPassiveChain }
      : {}),
    ...(context.damageResults !== undefined ? { damageResults: context.damageResults } : {}),
  };

  const working = new Map(units.map((unit) => [unit.battleUnitId, unit]));
  const gen = applyFollowUpAttacksSteps(
    damageContext,
    working,
    context.random,
    actor.battleUnitId,
    riders,
    capture.attackedTargetUnitIds,
    capture.anyCritical,
    parentEventId,
  );
  // `onFactEventForPassiveChain`を渡しているため連鎖は同期通知され、`yield`は
  // callback未指定経路の除去ステップだけになる。届いた中間`units`をそのまま注入して
  // 進める（`resolveDamage`のdriverと同じ規約の縮約形）。
  let step = gen.next();
  while (!step.done) {
    step = gen.next(step.value.units);
  }
  const result = step.value;
  // `NEXT_OUTGOING_ATTACK`/`NEXT_INCOMING_ATTACK`の消費で0になったインスタンスの
  // 遅延失効を確定させる（`applyDamageActionSteps`末尾と同じ契約）。callbackを
  // 渡しているため`driveRemovalSteps`は`yield`せず同期で完走する。
  const finalizeGen = driveRemovalSteps(
    damageContext,
    working,
    finalizeConsumedEffectDurations(Array.from(working.values()), result.lastEventId),
  );
  let finalizeStep = finalizeGen.next();
  while (!finalizeStep.done) {
    finalizeStep = finalizeGen.next(finalizeStep.value.units);
  }
  const lastEventId = finalizeStep.value.lastEventId;

  return {
    units: units.map((unit) => working.get(unit.battleUnitId) ?? unit),
    lastEventId,
  };
}
