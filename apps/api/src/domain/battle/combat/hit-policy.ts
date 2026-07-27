import type { AccuracyMode } from "../../catalog/definitions/catalog-enums.js";
import type { EffectActionDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { EffectInstanceId } from "../../shared/event-ids.js";
import type { RandomSource } from "../../ports/random-source.js";
import { createPercentage, resolveProbability } from "../../shared/percentage.js";
import type { AppliedEffect } from "../model/applied-effect.js";
import type { BattleUnit } from "../model/battle-unit.js";

export interface EvasionOutcome {
  readonly evaded: boolean;
  readonly evadedByEffectInstanceId?: EffectInstanceId;
  readonly evadedByEffectActionDefinitionId?: EffectActionDefinitionId;
}

function evasionAppliesToDamage(effect: AppliedEffect): boolean {
  const appliesTo = effect.statusDetails?.appliesTo;
  if (appliesTo === undefined) {
    return true;
  }
  return appliesTo.incomingActionKinds.includes("DAMAGE");
}

/**
 * `HitPolicy` (R-HIT-01, R-HIT-02). 通常の命中率・回避率は無く、暗闇(R-HIT-03、
 * `resolveEffectSequencePlan`のスキル使用単位ゲートで判定する)や特別な回避効果
 * (R-HIT-02、ここ)が無ければ必ず命中する。
 *
 * R-HIT-02: 攻撃が必中(`accuracyMode: "GUARANTEED"`)なら回避効果自体を発動
 * させない。対象がチャージ中なら自身の回避効果を発動させない。対象が持つ
 * 有効なEVASION `AppliedEffect`を付与順（`appliedEffects`の配列順）に判定し、
 * `appliesTo.incomingActionKinds`が指定されていれば`DAMAGE`を含む場合だけ対象、
 * 省略時は常に対象とする。`probability`省略時は常に回避する（production定義は
 * 常に明示するが、防御的既定値として1を採用する）。最初に確率判定へ成功した
 * 効果が回避を成立させる（判定はRandomSourceを効果ごとに順番に消費する）。
 */
export function resolveEvasion(
  target: BattleUnit,
  accuracyMode: AccuracyMode,
  random: RandomSource,
): EvasionOutcome {
  if (accuracyMode === "GUARANTEED") {
    return { evaded: false };
  }
  if (target.charge !== undefined) {
    return { evaded: false };
  }
  for (const effect of target.appliedEffects) {
    if (effect.statusKind !== "EVASION") {
      continue;
    }
    if (!evasionAppliesToDamage(effect)) {
      continue;
    }
    const probability = effect.statusDetails?.probability ?? 1;
    // R-NUM-03と同じ既定（`resolveCritical`のGUARANTEED分岐）: 確定した結果は
    // RandomSourceを消費しない。省略時は常に回避する防御的既定値のため、100%と
    // 同じ扱いにする。
    if (probability >= 1 || resolveProbability(createPercentage(probability), random)) {
      return {
        evaded: true,
        evadedByEffectInstanceId: effect.effectInstanceId,
        evadedByEffectActionDefinitionId: effect.effectActionDefinitionId,
      };
    }
  }
  return { evaded: false };
}

export interface DarknessCheck {
  readonly effectInstanceId: EffectInstanceId;
  readonly effectActionDefinitionId: EffectActionDefinitionId;
  readonly probability: number;
  readonly missed: boolean;
}

export interface DarknessOutcome {
  readonly missed: boolean;
  readonly checks: readonly DarknessCheck[];
}

/**
 * R-HIT-03/R-STS-04: スキル使用ごとに1回、使用者に付与された暗闇(`BLIND`
 * `AppliedEffect`)を付与順（`appliedEffects`の配列順）に取得し、各暗闇の指定
 * 確率で独立にMISS判定を行う（確率を加算・乗算して一つにまとめない）。いずれか
 * 一つでもMISSになればスキル全体をMISSとして扱う（`checks`は監査用に全件を
 * 保持する — 一つ目がMISSでも残りの判定を打ち切らない）。必中を持つスキルにも
 * 適用する（呼び出し側はこの結果をaccuracyModeに関わらず一律に適用する）。
 * `probability`省略時は常にMISSする防御的既定値とする（`resolveEvasion`と同じ
 * 理由）。
 */
export function resolveDarkness(attacker: BattleUnit, random: RandomSource): DarknessOutcome {
  const checks = attacker.appliedEffects
    .filter((effect) => effect.statusKind === "BLIND")
    .map((effect) => {
      const probability = effect.statusDetails?.probability ?? 1;
      const missed = probability >= 1 || resolveProbability(createPercentage(probability), random);
      return {
        effectInstanceId: effect.effectInstanceId,
        effectActionDefinitionId: effect.effectActionDefinitionId,
        probability,
        missed,
      };
    });
  return { missed: checks.some((check) => check.missed), checks };
}
