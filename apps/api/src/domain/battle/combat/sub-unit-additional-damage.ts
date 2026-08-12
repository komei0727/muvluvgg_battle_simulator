import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  subUnitAdditionalDamageSources,
  type SubUnitAdditionalDamageSource,
} from "./sub-unit-policy.js";
import { guardedDamage } from "./defensive-intervention-policy.js";
import { resolveDamageImmunity } from "./damage-immunity-policy.js";
import { composeDamageModifiers } from "./damage-modifier-policy.js";
import { resolveThresholdDamageReduction } from "./threshold-damage-reduction-policy.js";
import { evaluateFormula } from "../skill/formula-evaluator.js";
import type { DamageEventContext, DamageHitOutcome, DamageStep } from "./damage-event-context.js";
import {
  consumeAndExpire,
  driveRemovalSteps,
  findUnit,
  revalidateHit,
} from "./damage-hit-chain.js";
import { observeHitSteps, type HitObservationProfile } from "./damage-hit-observation.js";
import { resolveDefensiveInterventionsSteps } from "./damage-defensive-intervention.js";
import {
  applyConfirmedDamageSteps,
  type ConfirmedDamageApplication,
} from "./damage-hit-point-application.js";
import { applyLinkedDamageSteps, applyReflectedDamageSteps } from "./damage-propagation.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `applySubUnitAdditionalDamageSteps`の結果。`interrupted`は使用者の戦闘不能で追加
 * ヒットを未解決のまま残したことを表し、`ApplyDamageActionResult.interrupted`へ伝わる
 * （追加ヒットは`hits`に含まれないため`interruptedCount`では表せない）。
 */
export interface SubUnitAdditionalDamageResult {
  readonly lastEventId: DomainEventId;
  readonly interrupted: boolean;
}

/**
 * R-SUB-02（DMG-005）: 1つのDAMAGE EffectActionの解決が終わった直後に、使用者が保持する
 * サブユニットの追加ダメージを解決する。
 *
 * - 「所持者の攻撃対象ごとに追加ダメージを1ヒット加える」「複数対象への攻撃では、
 *   各対象へ1ヒットずつ加える」: この攻撃で実際に適用されたヒットの**対象**を
 *   重複なく（初出順で）並べ、その各対象へ加える。同じ対象への複数ヒットは
 *   1回にまとまる
 * - 所持者が同じサブユニットを複数保持していればその数だけ加える
 *   （production例: `SKL_OLGA_VETERAN_PS1`「サブユニット『カムラッドⅡ』を3つ付与する」）
 * - 「追加ダメージでは通常の防御力減衰を行わない」: `damage-calculator.ts`を
 *   経由せず、`SUBUNIT_ADDITIONAL_DAMAGE` Formula（対象の現在防御力をそのまま
 *   差し引く）の結果へ、通常のダメージ規則どおりの最終切り捨てと最低1ダメージ
 *   （R-DMG-02）だけを適用する。会心判定・命中判定・属性相性・与被ダメージ補正は
 *   いずれも行わない — R-SUB-02はそれらを一切規定せず、追加ダメージは所持者の
 *   スキルではなくサブユニットが持つ固定の効果だからである
 * - 使用者が途中で戦闘不能になり残りのヒットを中断した場合（R-SKL-01/R-SKL-03）は
 *   追加ダメージも行わない。既に戦闘不能になった対象も飛ばす（R-ACTN-01 #2）
 *
 * サブユニットの並びは**解決を始める前に**確定させる（`shieldDecayPools`と同じ
 * 規約）— 追加ダメージ自身のPS/Memory連鎖が新しいサブユニットを付与しても、同じ
 * 攻撃で連鎖的に追加ダメージが増えないようにするためである。実際の値（所持者の
 * 攻撃力・対象の防御力）だけをそのつど最新状態から求める。
 */
export function* applySubUnitAdditionalDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  outcomes: readonly DamageHitOutcome[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  interrupted: boolean,
  parentEventId: DomainEventId,
): Generator<DamageStep, SubUnitAdditionalDamageResult, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  if (interrupted) {
    // 元のヒット列が既に中断されている（`interruptedCount`が表す）。
    return { lastEventId, interrupted: false };
  }
  const attacker = working.get(attackerUnitId);
  const sources = attacker === undefined ? [] : subUnitAdditionalDamageSources(attacker);
  if (sources.length === 0) {
    // サブユニットを保持していなければ未解決の追加ヒットも存在しない。
    return { lastEventId, interrupted: false };
  }
  if (attacker === undefined || isDefeated(attacker)) {
    // 最後のヒットの連鎖で使用者が戦闘不能になった場合、追加ヒットは未解決のまま残る
    // （R-SKL-01「未解決効果を中断する」）。
    return { lastEventId, interrupted: true };
  }
  // 「所持者の**攻撃対象**ごとに」（R-SUB-02第1項）が数えるのは、その攻撃が誰を
  // 狙ったかであって、攻撃自身のヒットが通ったかではない — 追加ダメージは独立した
  // 1ヒットとして自前の命中判定を持つ（`applyOneSubUnitAdditionalDamageSteps`）ため、
  // 元のヒットが回避されていても対象からは外さない。既に戦闘不能な対象は下の
  // `isDefeated`判定が除く（R-ACTN-01 #2）。使用者の戦闘不能による中断
  // （`interrupted`）はこの関数の冒頭で既に打ち切っている。
  const targetUnitIds = [...new Set(outcomes.map((outcome) => outcome.targetUnitId))];

  // 追加ダメージのヒット番号は、この攻撃の追加ダメージ列の中で0から通し番号にする
  // （元のDAMAGE EffectActionのヒット番号とは別系列であり、`effectActionDefinitionId`
  // もサブユニット側の定義IDになるため衝突しない）。
  let additionalHitIndex = 0;
  for (const targetUnitId of targetUnitIds) {
    for (const source of sources) {
      const owner = working.get(attackerUnitId);
      if (owner === undefined || isDefeated(owner)) {
        return { lastEventId, interrupted: true };
      }
      const target = working.get(targetUnitId);
      if (target === undefined || isDefeated(target)) {
        break;
      }
      // このサブユニットが直前の連鎖で解除・枯渇していれば追加ダメージも起きない。
      const stillHeld = owner.appliedEffects.some(
        (effect) =>
          effect.effectInstanceId === source.effectInstanceId &&
          effect.subUnit !== undefined &&
          effect.subUnit.durability > 0,
      );
      if (!stillHeld) {
        continue;
      }
      const hitIndex = additionalHitIndex;
      additionalHitIndex += 1;
      const additionalHit = yield* applyOneSubUnitAdditionalDamageSteps(
        context,
        working,
        random,
        owner.battleUnitId,
        target.battleUnitId,
        source,
        {
          effectActionDefinitionId: source.effectActionDefinitionId,
          hitIndex,
          // R-SUB-02（`ApplySubunitPayload.additionalDamage.damageType`）: 明示が
          // なければこの追加ダメージの契機になった攻撃のダメージタイプを引き継ぐ。
          damageType: source.additionalDamage.damageType ?? damageAction.payload.damageType,
          // 命中特性は契機になった攻撃から引き継ぐ（`damageType`の既定と同じ規約）。
          accuracyMode: damageAction.payload.accuracy.mode,
          // R-SUB-02の計算式に会心の項が無く、Catalogにも会心モードの宣言が無い。
          criticalMode: "PREVENTED",
          // R-SUB-02にもCatalogスキーマにも追加ダメージの貫通を表す項が無い。
          piercing: {
            defenseIgnoreRate: 0,
            shieldIgnoreRate: 0,
            damageReductionIgnoreRate: 0,
          },
        },
        lastEventId,
      );
      lastEventId = additionalHit.lastEventId;
      // 追加ヒット自身の観測・吸収連鎖で使用者が戦闘不能になった場合も、残る追加ヒットを
      // 解決せずここで打ち切る（R-SKL-01）。
      if (additionalHit.kind === "INTERRUPT") {
        return { lastEventId, interrupted: true };
      }
    }
  }
  return { lastEventId, interrupted: false };
}

/**
 * `applySubUnitAdditionalDamageSteps`が1体×1対象について行う解決。
 *
 * raw原文（`戦闘システム.md`）の「サブユニットが攻撃に対して追加するダメージは
 * １ヒットとして扱われます」に従い、通常ヒットとまったく同じ観測（`observeHitSteps`）と
 * 適用（`applyConfirmedDamageSteps`）を通す。これによりNヒット回避（R-HIT-04）・
 * 被ヒット消費条件（R-EFF-07の`OUTGOING_HIT`/`INCOMING_HIT`）・`HitConfirmed`／
 * `CriticalCheckResolved`起点のPSが、追加ヒットも他のヒットと同じように観測できる。
 *
 * 通常ヒットと異なるのは**ダメージ計算だけ**で、R-SUB-02が定める次の3点に限られる。
 *
 * - `SUBUNIT_ADDITIONAL_DAMAGE` Formulaの結果をそのまま丸めて最終ダメージにする
 *   （`damage-calculator.ts`の防御力減衰・属性相性・与被ダメージ補正を経由しない、
 *   「追加ダメージでは通常の防御力減衰を行わない」）
 * - 会心は`PREVENTED`固定にする。R-SUB-02の計算式に会心の項が無く、サブユニットは
 *   会心モードを宣言するCatalog fieldも持たないためである（`CriticalCheckResolved`
 *   自体は他のヒットと同じく発行し、乱数も消費しない）
 * - 貫通（`piercing`）を持たない。R-SUB-02にもCatalogスキーマにも対応する項が無い
 *
 * `accuracy`は契機になった攻撃のものを引き継ぐ（`damageType`の既定と同じ規約）—
 * 追加ヒットは所持者の「その攻撃」に加わるものであり、独立した命中特性を持たない。
 */
function* applyOneSubUnitAdditionalDamageSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  targetUnitId: BattleUnitId,
  source: SubUnitAdditionalDamageSource,
  profile: HitObservationProfile,
  parentEventId: DomainEventId,
): Generator<DamageStep, ConfirmedDamageApplication, readonly BattleUnit[] | undefined> {
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
  // R-INT-01（DMG-006）: 追加ヒットも`DamageWillBeApplied`を発行する1ヒットである以上、
  // 防御介入の評価点を通常ヒットと分けない（`observeHitSteps`と
  // `applyConfirmedDamageSteps`を共有しているのと同じ理由）。
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
  const owner = findUnit(working, attackerUnitId, "attacker.battleUnitId");
  const target = findUnit(working, intervention.defenderUnitId, "hits[].targetUnitId");

  const formulaContext = {
    skillSource: owner,
    target,
    allUnits: Array.from(working.values()),
    subUnitProviderAttack: source.providerAttack,
  };
  const formulaResult = evaluateFormula(
    source.additionalDamage.formula,
    formulaContext,
    "subUnit.additionalDamage.formula",
  );
  // R-DMG-04（DMG-002）: 与／被ダメージ補正は「攻撃側／防御側に有効な`APPLY_DAMAGE_MOD`を
  // 集計する」規則であり、ダメージの出どころを限定していない。R-DOT-01が継続ダメージに
  // ついて「ダメージ軽減・増加、属性相性の影響を受けない」と明示的に除外しているのに対し、
  // R-SUB-02が除外するのは防御力減衰だけであるため、1ヒットとして扱う追加ダメージには
  // この補正が乗る。
  //
  // 集計はR-DMG-04末尾どおり`DamageWillBeApplied`の連鎖解決**後**にやり直す —
  // `observeHitSteps`が集計したsnapshotを使い回すと、公開イベントと`EVENT_PAYLOAD`条件が
  // 「実際には適用されない補正」を観測してしまう。
  const damageModifierMultipliers = composeDamageModifiers({
    attacker: owner,
    defender: target,
    damageType: profile.damageType,
    damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
  });
  // Q-DMG-01「ダメージ計算の途中では丸めず、最終結果で小数部分を切り捨てる」＋
  // R-DMG-02 #1/#3「最低1ダメージ」。属性相性（`attributeMultiplier`）と会心倍率が
  // 1のままなのは、R-SUB-02の計算式がそれらの項を持たないためである（`calculateDamage`の
  // 基本ダメージ式自体を経由しない）。
  // R-INT-02第2項（DMG-006）: 肩代わりの軽減率も通常ヒットと同じ位置
  // （最終切り捨ての前）で掛ける。
  const preTruncationDamage = guardedDamage(
    formulaResult *
      damageModifierMultipliers.outgoingMultiplier *
      damageModifierMultipliers.incomingMultiplier,
    intervention.guardRate,
  );
  const truncatedDamage = Math.max(1, Math.floor(preTruncationDamage));
  // R-DMG-07: R-DMG-04と同じく追加ヒットにも閾値付き被ダメージ軽減が乗る（R-SUB-02が
  // 除外するのは防御力減衰だけ）。判定素材・再切り捨て・消費の扱いは通常ヒットと同じ。
  const thresholdReduction = resolveThresholdDamageReduction({
    attacker: owner,
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
  // R-DMG-02「ダメージ無効効果がある場合も結果を1とする」: 通常ヒットと同じく、
  // 切り捨て・R-DMG-07軽減後の値を「incoming raw damage」として対象の有効な
  // DAMAGE_IMMUNITYを判定する。
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
    sourceUnitId: owner.battleUnitId,
    targetUnitIds: [target.battleUnitId],
    payload: {
      skillDefinitionId: context.skillDefinitionId,
      effectActionDefinitionId: profile.effectActionDefinitionId,
      hitIndex: profile.hitIndex,
      targetUnitId: target.battleUnitId,
      attackerAttack: owner.combatStats.attack,
      defenderDefense: target.combatStats.defense,
      // R-SUB-02末尾「追加ダメージでは通常の防御力減衰を行わない」: Formulaが
      // 対象の防御力をそのまま差し引くため、減衰後の実効防御という概念を持たない。
      effectiveDefense: target.combatStats.defense,
      defenseIgnoreRate: profile.piercing.defenseIgnoreRate,
      shieldIgnoreRate: profile.piercing.shieldIgnoreRate,
      damageReductionIgnoreRate: profile.piercing.damageReductionIgnoreRate,
      // `DamageCalculated.skillPower`はFormula評価結果そのもの（補正適用前）。
      skillPower: formulaResult,
      attributeMultiplier: 1,
      criticalMultiplier: observation.critical.multiplier,
      outgoingDamageMultiplier: damageModifierMultipliers.outgoingMultiplier,
      incomingDamageMultiplier: damageModifierMultipliers.incomingMultiplier,
      actionDamageMultiplier: 1,
      // R-CFS-02（DMG-009）: サブユニットの追加ダメージは混乱の対象外
      // （「ASの`DAMAGE` EffectActionだけに適用する」）ため常に1。
      confusionDamageMultiplier: 1,
      preTruncationDamage,
      finalDamage,
      damageType: profile.damageType,
    },
  });

  // R-DMG-07: 通常ヒットと同じく、軽減を実際に適用したインスタンスだけを
  // `DamageCalculated`発行後にインスタンス指定で`INCOMING_HIT`消費する。
  let consumptionEventId = damageCalculated.eventId;
  for (const applied of thresholdReduction.appliedEffects) {
    consumptionEventId = yield* consumeAndExpire(
      context,
      working,
      target.battleUnitId,
      "INCOMING_HIT",
      consumptionEventId,
      applied.effectInstanceId,
    );
  }

  const application = yield* applyConfirmedDamageSteps(
    context,
    working,
    owner.battleUnitId,
    target.battleUnitId,
    profile,
    finalDamage,
    consumptionEventId,
  );
  let lastEventId = application.lastEventId;
  if (application.kind !== "APPLIED") {
    return { kind: application.kind, lastEventId };
  }

  // R-INT-01 #3／R-LNK-01〜03: 追加ヒットも確定後にリンクを発生させる（通常ヒットと同じ）。
  // R-INT-01の評価順どおり反射（#4）より前である。
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

  // R-INT-01 #4／R-INT-03: 追加ヒットも確定後に反射を発生させる（通常ヒットと同じ）。
  const reflected = yield* applyReflectedDamageSteps(
    context,
    working,
    owner.battleUnitId,
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

  // R-SUB-02第3項「追加デバフが定義されている場合も対象ごとに適用する」。
  // 追加ダメージの適用が完了した後に付与する — デバフ（例:
  // `SKL_SHIRANA_SORA_AS1`の行動速度-20）が対象のCombatStatを変える前に、この
  // 追加ダメージ自身の計算を終えておくためである。
  //
  // 付与の直前に前提を再検証する。この追加ダメージ自身が対象を倒した場合や、
  // `DamageApplied`/`UnitDefeated`の連鎖が使用者を倒した場合、付与フックは通常の
  // EffectAction解決（`effect-action-group-resolver.ts`のR-ACTN-01 #2判定）を経由せず
  // 直接`grantEffect`まで進むため、ここで止めないと戦闘不能な対象へデバフが残り、
  // R-SKL-01の中断契約にも反する。
  const debuff = source.additionalDamage.debuff;
  if (debuff !== undefined && context.grantSubUnitAdditionalDamageDebuff !== undefined) {
    const beforeDebuff = revalidateHit(context, working, owner.battleUnitId, target.battleUnitId);
    if (beforeDebuff.kind !== "CONTINUE") {
      // 使用者の戦闘不能はこの攻撃の残りの追加ヒットも中断させる（R-SKL-01）。
      return { kind: beforeDebuff.kind, lastEventId };
    }
    const granted = yield* driveRemovalSteps(
      context,
      working,
      context.grantSubUnitAdditionalDamageDebuff(
        target.battleUnitId,
        debuff.effectActionDefinitionId,
        owner.battleUnitId,
        Array.from(working.values()),
        lastEventId,
      ),
    );
    lastEventId = granted.lastEventId;
  }
  return { kind: "APPLIED", lastEventId };
}
