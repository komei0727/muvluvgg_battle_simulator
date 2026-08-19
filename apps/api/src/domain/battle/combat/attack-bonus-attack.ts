import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import {
  applyOneAdditionalAttackHitSteps,
  type AdditionalAttackHitSpec,
} from "./additional-attack-hit.js";
import type { DamageEventContext, DamageHitOutcome, DamageStep } from "./damage-event-context.js";
import type { DomainEventId } from "../../shared/event-ids.js";
import type { EffectActionDefinition } from "../../catalog/definitions/effect-action-definition.js";
import type { RandomSource } from "../../ports/random-source.js";
import type { BattleUnitId } from "../../shared/ids.js";

/**
 * `applySubUnitAdditionalDamageSteps`と同じ形の結果。`interrupted`は使用者の戦闘不能で
 * 追加攻撃を未解決のまま残したことを表す（追加攻撃ヒットは`hits`に含まれないため
 * `interruptedCount`では表せない）。
 */
export interface AttackBonusAttackResult {
  readonly lastEventId: DomainEventId;
  readonly interrupted: boolean;
}

/**
 * R-DMG-06（`APPLY_ATTACK_DAMAGE_BONUS`、production定義: `SKL_ELENA_MOODMAKER_EX`の
 * 「攻撃時に攻撃力×15%のダメージを追加するバフ」）: 1つのDAMAGE EffectActionの解決が
 * 終わった直後に、保持者が持つ追加攻撃バフを解決する。
 *
 * - 数える単位は「ヒット」ではなく **DAMAGE EffectActionと攻撃対象**（R-SUB-02第1項と
 *   同じ規約）。3ヒット単体攻撃でも追加攻撃は1回、2体攻撃なら各1回になる
 * - 対象は**実際に当てた**対象に限る。1発も当たらなかった攻撃（全ヒットMISS・対象不在）
 *   では追加攻撃自体を行わない — 原文「攻撃時に…ダメージを追加する」が当たった攻撃を
 *   指すためであり、自前の命中判定を持つR-SUB-02の追加ヒットとはここが異なる
 * - 保持インスタンスごとに1回ずつ加える（重複可。保持数がそのまま追加攻撃回数になる）
 * - ダメージは付与時に焼き込んだ`magnitude`をそのまま基礎ダメージにする（`CONSTANT`
 *   Formula）。R-DMG-01「`SKILL_POWER`以外のFormulaは評価結果そのものが基礎ダメージに
 *   なる」により、対象の防御力で減衰しないことが構造的に成立する
 * - `damageType`は契機になった攻撃から継承する
 * - 使用者が途中で戦闘不能になり残りのヒットを中断した場合（R-SKL-01/R-SKL-03）は
 *   追加攻撃も行わない。既に戦闘不能になった対象も飛ばす（R-ACTN-01 #2）
 *
 * 1ヒットの解決（必中・会心継承・防御介入・与被ダメージ補正・閾値付き軽減・ダメージ
 * 無効・シールド吸収・リンク・反射・PS/Memory連鎖）は追撃（R-FUP-01）と共有する
 * `applyOneAdditionalAttackHitSteps`が行う。R-DMG-06 #9: 追加攻撃ヒットは呼び出し側の
 * `outcomes`へは積まれない（R-FUP-01の命中・会心集計を汚さない）が、R-SKL-08の直前結果と
 * `SUM_DAMAGE_*`の累計へは`applyConfirmedDamageSteps`が通常ヒットと同じく記録する。
 *
 * バフの並びは**解決を始める前に**確定させる（`applySubUnitAdditionalDamageSteps`の
 * サブユニット列と同じ規約）— 追加攻撃自身のPS/Memory連鎖が新しいバフを付与しても、
 * 同じ攻撃で連鎖的に追加攻撃が増えないようにするためである。
 */
export function* applyAttackBonusAttacksSteps(
  context: DamageEventContext,
  working: Map<BattleUnitId, BattleUnit>,
  random: RandomSource,
  attackerUnitId: BattleUnitId,
  outcomes: readonly DamageHitOutcome[],
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  interrupted: boolean,
  parentEventId: DomainEventId,
): Generator<DamageStep, AttackBonusAttackResult, readonly BattleUnit[] | undefined> {
  let lastEventId = parentEventId;
  if (interrupted) {
    // 元のヒット列（またはサブユニット追加ヒット）が既に中断されている。
    return { lastEventId, interrupted: false };
  }
  const holder = working.get(attackerUnitId);
  const bonuses = (holder?.appliedEffects ?? []).filter(
    (effect) => effect.isAttackDamageBonus === true,
  );
  if (bonuses.length === 0) {
    // 追加攻撃バフを保持していなければ未解決の追加攻撃も存在しない。
    return { lastEventId, interrupted: false };
  }
  if (holder === undefined || isDefeated(holder)) {
    // 最後のヒットの連鎖で使用者が戦闘不能になった場合、追加攻撃は未解決のまま残る
    // （R-SKL-01「未解決効果を中断する」）。
    return { lastEventId, interrupted: true };
  }
  // 「実際に当てた対象ごとに1ヒット」: 適用されたヒットの対象を重複なく初出順で並べる。
  const targetUnitIds = [
    ...new Set(
      outcomes.filter((outcome) => outcome.applied).map((outcome) => outcome.targetUnitId),
    ),
  ];

  // 追加攻撃のヒット番号は、この攻撃の追加攻撃列の中で0から通し番号にする（元のDAMAGE
  // EffectActionのヒット番号とは別系列であり、`effectActionDefinitionId`もバフ側の
  // 定義IDになるため衝突しない）。
  let bonusHitIndex = 0;
  for (const bonus of bonuses) {
    for (const targetUnitId of targetUnitIds) {
      const owner = working.get(attackerUnitId);
      if (owner === undefined || isDefeated(owner)) {
        return { lastEventId, interrupted: true };
      }
      // このバフが直前の連鎖で解除されていれば、残りの対象への追加攻撃も起きない。
      if (
        !owner.appliedEffects.some((effect) => effect.effectInstanceId === bonus.effectInstanceId)
      ) {
        break;
      }
      const target = working.get(targetUnitId);
      if (target === undefined || isDefeated(target)) {
        // R-ACTN-01 #2: 既に戦闘不能な対象は飛ばす。
        continue;
      }
      const hitIndex = bonusHitIndex;
      bonusHitIndex += 1;
      const bonusHit = yield* applyOneAdditionalAttackHitSteps(
        context,
        working,
        random,
        owner.battleUnitId,
        target.battleUnitId,
        attackBonusHitSpec(bonus, hitIndex, attackerUnitId, damageAction, outcomes, targetUnitId),
        lastEventId,
      );
      lastEventId = bonusHit.lastEventId;
      if (bonusHit.kind === "INTERRUPT") {
        return { lastEventId, interrupted: true };
      }
    }
  }
  return { lastEventId, interrupted: false };
}

function attackBonusHitSpec(
  bonus: AppliedEffect,
  hitIndex: number,
  attackerUnitId: BattleUnitId,
  damageAction: Extract<EffectActionDefinition, { kind: "DAMAGE" }>,
  outcomes: readonly DamageHitOutcome[],
  targetUnitId: BattleUnitId,
): AdditionalAttackHitSpec {
  return {
    effectActionDefinitionId: bonus.effectActionDefinitionId,
    hitIndex,
    // 原文「攻撃時に…ダメージを追加する」は追加分が元の攻撃と同じ種別であることを
    // 含意するため、payloadに項を足さず契機の攻撃から継承する。
    damageType: damageAction.payload.damageType,
    // 付与時に焼き込んだ加算量をそのまま基礎ダメージにする（防御力減衰なし）。
    skillPowerFormula: { kind: "CONSTANT", value: bonus.magnitude },
    // 会心は**その対象へ当たったヒット**のいずれかが会心なら会心とする。R-FUP-01 #5は
    // スキル使用単位で集計するが、本ルールはDAMAGE EffectAction単位・対象ごとに
    // 解決するため対象単位で継承する（単体攻撃では両者は一致する）。
    criticalMode: outcomes.some(
      (outcome) => outcome.applied && outcome.targetUnitId === targetUnitId && outcome.isCritical,
    )
      ? "GUARANTEED"
      : "PREVENTED",
    // 追加攻撃を行うのは保持者自身。付与者のステータスは`magnitude`（付与時snapshot）
    // に既に畳み込まれており、解決時には参照しない。
    skillSourceUnitId: attackerUnitId,
  };
}
