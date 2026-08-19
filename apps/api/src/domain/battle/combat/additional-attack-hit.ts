import { calculateDamage } from "./damage-calculator.js";
import { guardedDamage } from "./defensive-intervention-policy.js";
import { resolveDamageImmunity } from "./damage-immunity-policy.js";
import { composeDamageModifiers } from "./damage-modifier-policy.js";
import { resolveThresholdDamageReduction } from "./threshold-damage-reduction-policy.js";
import { damageResultsFor } from "../skill/formula-evaluator.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
import {
  consumeAndExpire,
  driveRemovalSteps,
  findUnit,
  revalidateHit,
} from "./damage-hit-chain.js";
import { observeHitSteps } from "./damage-hit-observation.js";
import { resolveDefensiveInterventionsSteps } from "./damage-defensive-intervention.js";
import {
  applyConfirmedDamageSteps,
  type ConfirmedDamageApplication,
} from "./damage-hit-point-application.js";
import { applyLinkedDamageSteps, applyReflectedDamageSteps } from "./damage-propagation.js";
import type { BattleUnit } from "../model/battle-unit.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnitId } from "../../shared/ids.js";

/** 追加攻撃ヒットの適用後に、そのヒットが適用された対象へ付与する効果。 */
export interface AdditionalAttackOnHitEffect {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  /** 付与の帰属先（`sourceUnitId`）。Memory由来等では`undefined`。 */
  readonly sourceUnitId: BattleUnitId | undefined;
}

/** 追加攻撃1ヒット分の解決素材。呼び出し側ごとに変わる差分だけを持つ。 */
export interface AdditionalAttackHitSpec {
  /** ヒット観測・イベントの帰属先。 */
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  /** 元のDAMAGE EffectActionのヒット番号とは別系列の、追加攻撃列の中での通し番号。 */
  readonly hitIndex: number;
  readonly damageType: DamageType;
  /** `calculateDamage`の`skillPowerFormula`へそのまま渡す。 */
  readonly skillPowerFormula: FormulaDefinition;
  /** 元の攻撃から継承した会心（乱数非消費）。 */
  readonly criticalMode: "GUARANTEED" | "PREVENTED";
  /** Formula評価の`SKILL_SOURCE`として使うユニット。 */
  readonly skillSourceUnitId: BattleUnitId;
  readonly onHitEffect?: AdditionalAttackOnHitEffect;
}

/**
 * 元の攻撃に相乗りする追加攻撃1ヒットを解決する。追撃（R-FUP-01）と攻撃時追加ダメージが
 * 共有する経路であり、通常ヒットと異なるのは次の3点だけで、それ以外
 * （`observeHitSteps`の観測列・防御介入・与被ダメージ補正・閾値付き軽減・ダメージ無効・
 * シールド吸収・リンク・反射・PS/Memory連鎖）は通常ヒットとまったく同じ経路を通る。
 *
 * - 命中判定を独自に行わない: 元攻撃が命中した場合だけ呼び出され（ゲートは呼び出し側の
 *   責務）、このヒット自身は必中（`accuracyMode: "GUARANTEED"`、乱数を消費しない）
 * - 会心判定を独自に行わない: 呼び出し側が元攻撃から継承した`criticalMode`を宣言する
 *   （乱数非消費）。会心倍率は攻撃者の会心ダメージボーナスから求め、攻撃者が保持する
 *   会心不可（R-CRT-03 #1）は`resolveEffectiveCriticalMode`の畳み込みでこの宣言より
 *   優先される
 * - ダメージ計算は`calculateDamage`を通常どおり通す（攻撃者のステータス・属性相性・
 *   防御減衰あり）が、凍結解除・増幅（R-STS-03）と攻撃時追加ダメージ（R-DMG-06）と
 *   混乱（R-CFS-02）は適用しない（R-SUB-02と同じ「同じ攻撃の中で二重に数えない」境界）。
 *   サブユニット追加ダメージ（R-SUB-02）も誘発せず、貫通も持たない
 */
export function* applyOneAdditionalAttackHitSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  spec: AdditionalAttackHitSpec,
  parentEventId: DomainEventId,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  const profile = {
    effectActionDefinitionId: spec.effectActionDefinitionId,
    hitIndex: spec.hitIndex,
    damageType: spec.damageType,
    // 必中（乱数非消費）。暗闇のスキル使用単位ゲート（R-HIT-03）は元攻撃側で判定済み。
    accuracyMode: "GUARANTEED" as const,
    criticalMode: spec.criticalMode,
    // R-FUP-01にもCatalogスキーマにも追加攻撃の貫通を表す項が無い。
    piercing: { defenseIgnoreRate: 0, shieldIgnoreRate: 0, damageReductionIgnoreRate: 0 },
  };
  const observation = yield* observeHitSteps(
    context,
    working,
    random,
    attackerUnitId,
    targetUnitId,
    profile,
    parentEventId,
  );
  if (observation.kind !== "CONFIRMED") {
    return { kind: observation.kind, lastEventId: observation.lastEventId };
  }
  // R-INT-01（DMG-006）: 追加攻撃ヒットも`DamageWillBeApplied`を発行する1ヒットである
  // 以上、防御介入の評価点を通常ヒットと分けない（R-SUB-02の追加ヒットと同じ理由）。
  const intervention = yield* resolveDefensiveInterventionsSteps(
    context,
    working,
    attackerUnitId,
    targetUnitId,
    { effectActionDefinitionId: profile.effectActionDefinitionId, hitIndex: profile.hitIndex },
    observation.lastEventId,
  );
  if (intervention.kind !== "RESOLVED") {
    return { kind: intervention.kind, lastEventId: intervention.lastEventId };
  }
  const attacker = findUnit(working, attackerUnitId, "attacker.battleUnitId");
  const target = findUnit(working, intervention.defenderUnitId, "hits[].targetUnitId");

  const formulaContext = {
    skillSource: findUnit(working, spec.skillSourceUnitId, "skillSource.battleUnitId"),
    target,
    allUnits: Array.from(working.values()),
    lastResults: damageResultsFor(context.damageResults, attackerUnitId, context.skillUseId),
  };
  const damageModifierMultipliers = composeDamageModifiers({
    attacker,
    defender: target,
    damageType: profile.damageType,
    damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
  });
  const rawDamageResult = calculateDamage({
    attackerAttack: attacker.combatStats.attack,
    attackerAttribute: attacker.attribute,
    attackerAffinityBonus: attacker.combatStats.affinityBonus,
    defenderDefense: target.combatStats.defense,
    defenderAttribute: target.attribute,
    defenseIgnoreRate: profile.piercing.defenseIgnoreRate,
    skillPowerFormula: spec.skillPowerFormula,
    damageModifiers: [],
    criticalMultiplier: observation.critical.multiplier,
    outgoingDamageMultiplier: damageModifierMultipliers.outgoingMultiplier,
    incomingDamageMultiplier: damageModifierMultipliers.incomingMultiplier,
    formulaContext,
    // R-CFS-02（DMG-009）: 混乱は「ASのDAMAGE EffectAction」だけに働くため適用しない。
  });
  // R-STS-03の凍結解除・増幅とR-DMG-06の攻撃時追加ダメージは適用しない
  // （R-SUB-02と同じ「同じ攻撃の中で二重に数えない」境界）。
  // R-INT-02第2項: 肩代わりの軽減率は最終切り捨ての前に掛ける（Q-DMG-01）。
  const preTruncationDamage = guardedDamage(
    rawDamageResult.preTruncationDamage,
    intervention.guardRate,
  );
  const truncatedDamage = Math.max(1, Math.floor(preTruncationDamage));
  // R-DMG-07: 追加攻撃ヒットにも閾値付き被ダメージ軽減が乗る（適用範囲はR-DMG-04と同じ）。
  const thresholdReduction = resolveThresholdDamageReduction({
    attacker,
    defender: target,
    damageType: profile.damageType,
    incomingDamage: truncatedDamage,
    damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
    formulaContext,
  });
  const thresholdReducedDamage = Math.max(
    1,
    Math.floor(truncatedDamage * thresholdReduction.multiplier),
  );
  // R-DMG-02 #2: ダメージ無効は軽減後の値を判定素材とし、成立すれば最終結果を1にする。
  const damageImmunity = resolveDamageImmunity(target, thresholdReducedDamage, formulaContext);
  const finalDamage = damageImmunity.nullified ? 1 : thresholdReducedDamage;

  const damageCalculated = context.recorder.record({
    eventType: "DamageCalculated",
    category: "FACT",
    turnNumber: context.turnNumber,
    cycleNumber: context.cycleNumber,
    ...(context.actionId !== undefined ? { actionId: context.actionId } : {}),
    skillUseId: context.skillUseId,
    resolutionScopeId: context.resolutionScopeId,
    parentEventId: observation.damageWillBeAppliedEventId,
    rootEventId: context.rootEventId,
    sourceUnitId: attacker.battleUnitId,
    targetUnitIds: [target.battleUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId: target.battleUnitId,
      attackerAttack: attacker.combatStats.attack,
      defenderDefense: target.combatStats.defense,
      effectiveDefense: rawDamageResult.effectiveDefense,
      defenseIgnoreRate: profile.piercing.defenseIgnoreRate,
      shieldIgnoreRate: profile.piercing.shieldIgnoreRate,
      damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
      baseDamage: rawDamageResult.baseDamage,
      skillPower: rawDamageResult.skillPower,
      skillPowerFormulaKind: rawDamageResult.skillPowerFormulaKind,
      attributeMultiplier: rawDamageResult.attributeMultiplier,
      attackerAttribute: attacker.attribute,
      defenderAttribute: target.attribute,
      isFavorableAttribute: rawDamageResult.isFavorableAttribute,
      attackerAffinityBonus: attacker.combatStats.affinityBonus,
      criticalMultiplier: observation.critical.multiplier,
      outgoingDamageMultiplier: rawDamageResult.outgoingDamageMultiplier,
      incomingDamageMultiplier: rawDamageResult.incomingDamageMultiplier,
      actionDamageMultiplier: rawDamageResult.actionDamageMultiplier,
      confusionDamageMultiplier: rawDamageResult.confusionDamageMultiplier,
      rawPreTruncationDamage: rawDamageResult.preTruncationDamage,
      preTruncationDamage,
      // 凍結解除増幅（R-STS-03）と攻撃時追加ダメージ（R-DMG-06）は追加攻撃へ適用しない
      // ため、この経路では常に中立値になる。
      freezeMultiplier: 1,
      attackDamageBonus: 0,
      guardRate: intervention.guardRate,
      thresholdReductionMultiplier: thresholdReduction.multiplier,
      damageImmunityNullified: damageImmunity.nullified,
      finalDamage,
      damageType: profile.damageType,
    },
  });

  const application = yield* applyConfirmedDamageSteps(
    context,
    working,
    attacker.battleUnitId,
    target.battleUnitId,
    profile,
    finalDamage,
    damageCalculated.eventId,
  );
  let lastEventId = application.lastEventId;
  if (application.kind !== "APPLIED") {
    return { kind: application.kind, lastEventId };
  }

  // R-DMG-07: 軽減を実際に適用したインスタンスだけを`INCOMING_HIT`消費する
  // （通常ヒット・サブユニット追加ヒットと同じ順序 — `DamageApplied`の後）。
  for (const applied of thresholdReduction.appliedEffects) {
    lastEventId = yield* consumeAndExpire(
      context,
      working,
      target.battleUnitId,
      "INCOMING_HIT",
      lastEventId,
      applied.effectInstanceId,
    );
  }

  // R-INT-01 #3／R-LNK-01〜03: 追加攻撃ヒットも確定後にリンクを発生させる。
  const linked = yield* applyLinkedDamageSteps(
    context,
    working,
    target.battleUnitId,
    profile.damageType,
    finalDamage,
    intervention.damageLinks,
    application.damageAppliedEventId ?? lastEventId,
    lastEventId,
  );
  lastEventId = linked.lastEventId;
  if (linked.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }

  // R-INT-01 #4／R-INT-03: 追加攻撃ヒットも確定後に反射を発生させる。
  const reflected = yield* applyReflectedDamageSteps(
    context,
    working,
    attacker.battleUnitId,
    target.battleUnitId,
    profile.damageType,
    finalDamage,
    intervention.reflects,
    application.damageAppliedEventId ?? lastEventId,
    lastEventId,
  );
  lastEventId = reflected.lastEventId;
  if (reflected.kind === "INTERRUPT") {
    return { kind: "INTERRUPT", lastEventId };
  }

  // R-FUP-01 #9: onHitEffectはヒットの適用が完了した後に付与する。付与の直前に使用者・
  // 対象の生存を再検証する（R-SUB-02第3項の追加デバフと同じ規約 — この追加攻撃自身が
  // 対象を倒した場合や、連鎖が使用者を倒した場合には付与しない）。
  if (spec.onHitEffect !== undefined && context.grantFollowUpOnHitEffect !== undefined) {
    const beforeOnHit = revalidateHit(context, working, attacker.battleUnitId, target.battleUnitId);
    if (beforeOnHit.kind !== "CONTINUE") {
      return { kind: beforeOnHit.kind, lastEventId };
    }
    const granted = yield* driveRemovalSteps(
      context,
      working,
      context.grantFollowUpOnHitEffect(
        target.battleUnitId,
        spec.onHitEffect.effectActionDefinitionId,
        attacker.battleUnitId,
        spec.onHitEffect.sourceUnitId,
        Array.from(working.values()),
        lastEventId,
      ),
    );
    lastEventId = granted.lastEventId;
  }
  return { kind: "APPLIED", lastEventId };
}
