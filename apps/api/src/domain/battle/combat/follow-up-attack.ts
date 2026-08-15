import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
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
import type { DomainEventId } from "../../shared/event-ids.js";
import type { DamageType } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormulaDefinition } from "../../catalog/definitions/formula-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * R-FUP-01（Issue #474）: 1回のスキル使用に相乗りする追撃1件分の解決素材。
 * 元の`AppliedEffect`はスキル途中（最初のDAMAGE EffectAction末尾の
 * `NEXT_OUTGOING_ATTACK`消費）で失効しているため、呼び出し側（lifecycle層）が
 * Catalogから引き直した定義内容を平データとして渡す。
 */
export interface FollowUpAttackRider {
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  /** ライダーを付与したユニット（onHitEffectの帰属先）。Memory由来等では`undefined`。 */
  readonly sourceUnitId?: BattleUnitId;
  readonly damageType: DamageType;
  readonly formula: FormulaDefinition;
  readonly onHitEffectActionDefinitionId?: EffectActionDefinitionId;
}

/** `applySubUnitAdditionalDamageSteps`と同じ形の結果（中断は独立フラグで表す）。 */
export interface FollowUpAttackResult {
  readonly lastEventId: DomainEventId;
  readonly interrupted: boolean;
}

/**
 * R-FUP-01: スキル使用の全step解決後・`SkillUseCompleted`発行前に1回だけ、捕捉済みの
 * ライダーごと×攻撃対象ごとに追撃ヒットを解決する。
 *
 * 通常ヒットと異なるのは次の3点だけで、それ以外（`observeHitSteps`の観測列・防御介入・
 * 与被ダメージ補正・閾値付き軽減・ダメージ無効・シールド吸収・リンク・反射・PS/Memory
 * 連鎖）は通常ヒットとまったく同じ経路を通る。
 *
 * - 命中判定を独自に行わない: 元攻撃が1発でも命中した場合だけ呼び出され（呼び出し側が
 *   `capture.anyApplied`でゲートする）、追撃自身は必中（`accuracyMode: "GUARANTEED"`、
 *   乱数を消費しない）として扱う
 * - 会心判定を独自に行わない: 元攻撃のいずれかのヒットが会心なら`GUARANTEED`、
 *   1発も会心でなければ`PREVENTED`を宣言し（どちらも乱数を消費しない）、会心倍率は
 *   保持者（攻撃者）の会心ダメージボーナスから求める
 * - ダメージ計算は`calculateDamage`を通常どおり通す（攻撃者=保持者のステータス・
 *   属性相性・防御減衰あり）が、凍結解除・増幅（R-STS-03）と攻撃時追加ダメージ
 *   （R-DMG-06）と混乱（R-CFS-02）は適用しない（R-SUB-02と同じ「同じ攻撃の中で
 *   二重に数えない」境界）。サブユニット追加ダメージ（R-SUB-02）も誘発しない
 *
 * ライダーの並びと対象列は解決を始める前に確定済み（`FollowUpAttackCapture`）であり、
 * 追撃自身のPS/Memory連鎖が新しいライダーを付与しても同じ攻撃で連鎖的に追撃は増えない
 * （`applySubUnitAdditionalDamageSteps`と同じ規約）。
 */
export function* applyFollowUpAttacksSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  riders: readonly FollowUpAttackRider[],
  targetUnitIds: readonly BattleUnitId[],
  inheritedCritical: boolean,
  parentEventId: DomainEventId,
): Generator<DamageStep, FollowUpAttackResult, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  // 追撃ヒットのヒット番号は追撃列の中で0からの通し番号にする（R-SUB-02の追加ヒットと
  // 同じく、元のDAMAGE EffectActionのヒット番号とは別系列）。
  let followUpHitIndex = 0;
  for (const rider of riders) {
    for (const targetUnitId of targetUnitIds) {
      const attacker = working.get(attackerUnitId);
      if (attacker === undefined || isDefeated(attacker)) {
        // R-SKL-01: 使用者の戦闘不能は残りの追撃を未解決のまま中断する。
        return { lastEventId, interrupted: true };
      }
      const target = working.get(targetUnitId);
      if (target === undefined || isDefeated(target)) {
        // R-ACTN-01 #2: 既に戦闘不能な対象は飛ばす。
        continue;
      }
      const hitIndex = followUpHitIndex;
      followUpHitIndex += 1;
      const followUpHit = yield* applyOneFollowUpAttackHitSteps(
        context,
        working,
        random,
        attackerUnitId,
        targetUnitId,
        rider,
        hitIndex,
        inheritedCritical,
        lastEventId,
      );
      lastEventId = followUpHit.lastEventId;
      if (followUpHit.kind === "INTERRUPT") {
        return { lastEventId, interrupted: true };
      }
    }
  }
  return { lastEventId, interrupted: false };
}

function* applyOneFollowUpAttackHitSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  rider: FollowUpAttackRider,
  hitIndex: number,
  inheritedCritical: boolean,
  parentEventId: DomainEventId,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
  const profile = {
    effectActionDefinitionId: rider.effectActionDefinitionId,
    hitIndex,
    damageType: rider.damageType,
    // 必中（乱数非消費）。暗闇のスキル使用単位ゲート（R-HIT-03）は元攻撃側で判定済み。
    accuracyMode: "GUARANTEED" as const,
    // 元攻撃からの会心継承（乱数非消費）。使用者が保持する会心不可（R-CRT-03 #1）は
    // `resolveEffectiveCriticalMode`の畳み込みでこの宣言より優先される。
    criticalMode: inheritedCritical ? ("GUARANTEED" as const) : ("PREVENTED" as const),
    // R-FUP-01にもCatalogスキーマにも追撃の貫通を表す項が無い。
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
  // R-INT-01（DMG-006）: 追撃ヒットも`DamageWillBeApplied`を発行する1ヒットである以上、
  // 防御介入の評価点を通常ヒットと分けない（R-SUB-02の追加ヒットと同じ理由）。
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

  // R-FUP-01: ダメージ計算の`SKILL_SOURCE`は保持者（攻撃した味方）自身。ライダーの
  // 付与者のステータスは一切参照しない。
  const formulaContext = {
    skillSource: attacker,
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
    skillPowerFormula: rider.formula,
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
  // R-DMG-07: 追撃ヒットにも閾値付き被ダメージ軽減が乗る（適用範囲はR-DMG-04と同じ）。
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
      // R-FUP-01: 凍結解除増幅（R-STS-03）と攻撃時追加ダメージ（R-DMG-06）は追撃へ
      // 適用しないため、この経路では常に中立値になる。
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

  // R-INT-01 #3／R-LNK-01〜03: 追撃ヒットも確定後にリンクを発生させる。
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

  // R-INT-01 #4／R-INT-03: 追撃ヒットも確定後に反射を発生させる。
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

  // R-FUP-01: onHitEffectは追撃ヒットの適用が完了した後に付与する。付与の直前に
  // 使用者・対象の生存を再検証する（R-SUB-02第3項の追加デバフと同じ規約 — この追撃
  // 自身が対象を倒した場合や、連鎖が使用者を倒した場合には付与しない）。
  if (
    rider.onHitEffectActionDefinitionId !== undefined &&
    context.grantFollowUpOnHitEffect !== undefined
  ) {
    const beforeOnHit = revalidateHit(context, working, attacker.battleUnitId, target.battleUnitId);
    if (beforeOnHit.kind !== "CONTINUE") {
      return { kind: beforeOnHit.kind, lastEventId };
    }
    const granted = yield* driveRemovalSteps(
      context,
      working,
      context.grantFollowUpOnHitEffect(
        target.battleUnitId,
        rider.onHitEffectActionDefinitionId,
        attacker.battleUnitId,
        rider.sourceUnitId,
        Array.from(working.values()),
        lastEventId,
      ),
    );
    lastEventId = granted.lastEventId;
  }
  return { kind: "APPLIED", lastEventId };
}
