import { applyFollowUpAttacksSteps, type FollowUpAttackRider } from "../combat/follow-up-attack.js";
import { driveRemovalSteps } from "../combat/damage-hit-chain.js";
import type {
  DamageEventContext,
  FollowUpAttackCapture,
} from "../combat/damage-application-service.js";
import { expireEffectsSteps } from "../effects/duration-expiry-service.js";
import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import { grantOnHitEffectSteps } from "./effect-action/on-hit-effect-grant.js";
import { applyDeathSurvivalHealSteps } from "./effect-action/damage-effect-action.js";
import { buildConsumeEffectDurationHooks } from "./effect-action/effect-duration-consumption.js";
import {
  eventContextOf,
  requireSkillDefinitionId,
  skillTypeOf,
  type EffectActionGroupContext,
} from "./effect-action/effect-action-group-context.js";
import type { DomainEventId } from "../../shared/event-ids.js";

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
): {
  readonly units: readonly BattleUnit[];
  readonly lastEventId: DomainEventId;
  /**
   * R-SKL-01: 追撃の解決中に使用者が戦闘不能になり、未解決の追撃を残して中断した
   * 場合`true`。呼び出し側（`action-skill-use-resolver.ts`）はこれを外側のスキル
   * 使用結果へ伝播し、`SkillUseCompleted`ではなく`SkillUseInterrupted`を発行する —
   * 完了契機PSや`SKILL_USE`単位期間減算を誤って走らせないためである。
   */
  readonly interrupted: boolean;
} {
  if (capture.riders.size === 0 || !capture.anyApplied || context.actorUnitId === undefined) {
    return { units, lastEventId: parentEventId, interrupted: false };
  }
  const actor = units.find((unit) => unit.battleUnitId === context.actorUnitId);
  if (actor === undefined || isDefeated(actor)) {
    // R-SKL-01: 使用者が既に戦闘不能なら追撃も行わない（中断経路はここへ到達しない）。
    return { units, lastEventId: parentEventId, interrupted: false };
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
      ...(definition.payload.onHitEffects !== undefined
        ? {
            onHitEffectActionDefinitionIds: definition.payload.onHitEffects.map(
              (onHitEffect) => onHitEffect.effectActionDefinitionId,
            ),
          }
        : {}),
    });
  }
  if (riders.length === 0) {
    return { units, lastEventId: parentEventId, interrupted: false };
  }

  const { consumeEffectDuration, finalizeConsumedEffectDurations, beginNextAttack } =
    buildConsumeEffectDurationHooks(context);
  const skillType = skillTypeOf(context);
  const damageContext: DamageEventContext = {
    ...eventContextOf(context),
    parentEventId,
    skillDefinitionId: requireSkillDefinitionId(context),
    ...(skillType !== undefined ? { skillType } : {}),
    consumeEffectDuration,
    finalizeConsumedEffectDurations,
    beginNextAttack,
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
      grantOnHitEffectSteps(
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
    ...(context.triggerSkillUseId !== undefined
      ? { triggerSkillUseId: context.triggerSkillUseId }
      : {}),
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
    interrupted: result.interrupted,
  };
}
