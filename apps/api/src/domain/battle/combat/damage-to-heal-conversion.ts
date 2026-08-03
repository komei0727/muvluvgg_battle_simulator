import { activeStatusEffect, type BattleUnit } from "../model/battle-unit.js";
import { recordDamageResult } from "../skill/formula-evaluator.js";
import { createHitPoint, truncateFraction } from "../model/resource-gauge.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import { consumeAndExpire, findUnit } from "./damage-hit-chain.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * R-DTH-01（DMG-009）: このヒットのダメージを回復へ変換する割合。幻惑を保持しない
 * 攻撃側では`undefined`。混乱と違いスキル種別を問わない。
 */
export function resolveDamageToHealRate(attacker: BattleUnit): number | undefined {
  return activeStatusEffect(attacker, "DAMAGE_TO_HEAL")?.statusDetails?.damageToHeal?.healRate;
}

/**
 * R-DTH-01（DMG-009）: 幻惑を保持する攻撃側のヒットについて、R-DMG-05 #7の適用だけを
 * ダメージから回復へ差し替える。`DamageCalculated`までは通常のヒットとまったく同じ経路を
 * 通っており、この関数はその確定ダメージを受け取る。
 *
 * - 回復量は`floor(最終ダメージ × healRate)`。回復量補正（R-HEAL-02）も回復リンク
 *   （R-HEAL-04）も適用しない — 本来のダメージ量からの変換であって回復Formulaの
 *   評価ではないためで、リンクダメージが属性・会心・ダメージ増減を再計算しないの
 *   （R-LNK-02第3項）とまったく同じ規約である
 * - 最大HPを超える分は破棄する（R-HEAL-01の`overheal: DISCARD`と同じ）。`healAmount`と
 *   実際に増えた`appliedHeal`の両方をpayloadへ載せ、破棄量を監査できるようにする
 * - HP変化のStateDeltaはこのイベントが持つ（`HealApplied`・`HitPointReduced`と同じ
 *   規約 — 1つのHP変化を2つのイベントへ付けると独立Reducer復元が二重適用する）
 * - ダメージを適用しないため`DamageApplied`・`UnitDefeated`・リンク・反射は発生しない。
 *   一方、命中は確定しているためR-EFF-07のヒット消費（`OUTGOING_HIT`/`INCOMING_HIT`）
 *   は通常のヒットと同じく行う
 */
export function* applyDamageToHealConversionSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  profile: {
    readonly effectActionDefinitionId: EffectActionDefinitionId;
    readonly hitIndex: number;
  },
  calculatedDamage: number,
  healRate: number,
  parentEventId: DomainEventId,
): Generator<DamageStep, DomainEventId, readonly BattleUnit[] | undefined> {
  const target = findUnit(working, targetUnitId, "hits[].targetBattleUnitId");
  const healAmount = Math.floor(calculatedDamage * healRate);
  const hpBefore = target.currentHp;
  // R-NUM-02: `combatStats.maximumHp`は全精度で保持されるため、HPゲージへ渡す境界で
  // 0方向へ切り捨てて整数化する（ダメージ側のHP適用とまったく同じ扱い）。
  const maximumHp = truncateFraction(target.combatStats.maximumHp);
  const hpAfter = Math.min(maximumHp, hpBefore + healAmount);
  const appliedHeal = hpAfter - hpBefore;
  working.set(targetUnitId, { ...target, currentHp: createHitPoint(hpAfter, maximumHp) });

  // R-DTH-01「変換されたヒットは、R-SKL-08が参照する直前DAMAGE結果として0を記録する」。
  recordDamageResult(context.damageResults, attackerUnitId, targetUnitId, 0, context.skillUseId);

  const converted = context.recorder.record({
    eventType: "DamageConvertedToHeal",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attackerUnitId,
    targetUnitIds: [targetUnitId],
    payload: {
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId,
      calculatedDamage,
      healRate,
      healAmount,
      appliedHeal,
      hpBefore,
      hpAfter,
    },
    stateDelta: { units: { [targetUnitId]: { hp: { before: hpBefore, after: hpAfter } } } },
  });
  // `DamageApplied`とまったく同じ規約: AS/EX・チャージ解放（callbackあり）ではその場で
  // 連鎖を解決し、PS/Memory自身のEffectSequence解決では`effect-action-group-resolver.ts`が
  // `innerEvents`としてEffectAction完了時にまとめてdriverへ渡す。
  if (context.onFactEventForPassiveChain !== undefined) {
    const updatedUnits = context.onFactEventForPassiveChain(
      converted,
      Array.from(working.values()),
    );
    for (const unit of updatedUnits) {
      working.set(unit.battleUnitId, unit);
    }
  }

  let lastEventId = converted.eventId;
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    attackerUnitId,
    "OUTGOING_HIT",
    lastEventId,
  );
  lastEventId = yield* consumeAndExpire(
    context,
    working,
    targetUnitId,
    "INCOMING_HIT",
    lastEventId,
  );
  return lastEventId;
}
