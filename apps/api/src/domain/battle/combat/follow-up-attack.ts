import { isDefeated, type BattleUnit } from "../model/battle-unit.js";
import {
  applyOneAdditionalAttackHitSteps,
  type AdditionalAttackHitSpec,
} from "./additional-attack-hit.js";
import type { DamageEventContext, DamageStep } from "./damage-event-context.js";
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
 * 1ヒット分の解決は`applyOneAdditionalAttackHitSteps`（追加攻撃と共通）へ委譲する。
 * 追撃固有の差分は、必中扱い（呼び出し側が`capture.anyApplied`でゲート済み）・元攻撃から
 * 継承した会心・`SKILL_SOURCE`＝保持者（R-FUP-01 #7。ライダーの付与者のステータスは
 * 一切参照しない）の3点である。
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
      const followUpHit = yield* applyOneAdditionalAttackHitSteps(
        context,
        working,
        random,
        attackerUnitId,
        targetUnitId,
        followUpAttackHitSpec(rider, hitIndex, attackerUnitId, inheritedCritical),
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

function followUpAttackHitSpec(
  rider: FollowUpAttackRider,
  hitIndex: number,
  attackerUnitId: BattleUnitId,
  inheritedCritical: boolean,
): AdditionalAttackHitSpec {
  return {
    effectActionDefinitionId: rider.effectActionDefinitionId,
    hitIndex,
    damageType: rider.damageType,
    skillPowerFormula: rider.formula,
    // R-FUP-01 #5: 元攻撃のいずれかのヒットが会心なら追撃も会心、1発も会心でなければ
    // 非会心（どちらも乱数を消費しない）。
    criticalMode: inheritedCritical ? "GUARANTEED" : "PREVENTED",
    // R-FUP-01 #7: `SKILL_SOURCE`は保持者（攻撃した味方）自身。
    skillSourceUnitId: attackerUnitId,
    ...(rider.onHitEffectActionDefinitionId !== undefined
      ? {
          onHitEffect: {
            effectActionDefinitionId: rider.onHitEffectActionDefinitionId,
            sourceUnitId: rider.sourceUnitId,
          },
        }
      : {}),
  };
}
