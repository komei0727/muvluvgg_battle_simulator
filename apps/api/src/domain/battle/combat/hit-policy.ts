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
 * R-HIT-05「必中付与」（M7-018、Issue #272）: 使用者が有効な必中効果
 * （`APPLY_STATUS`の`status: "GUARANTEED_HIT"`）を持つ場合、攻撃側の効果定義が
 * `accuracy.mode: "NORMAL"`でもその攻撃を必中として扱う。呼び出し側は解決した
 * この実効値を`resolveEvasion`へ渡す — R-HIT-02/R-HIT-04の回避効果はどちらも
 * 必中に対して発動しない。暗闇（R-HIT-03/R-STS-04）はこの実効値を参照しない
 * （`resolveDarkness`は`accuracyMode`を引数に取らない）: R-HIT-03 #6「必中を
 * 持つスキルにも適用する」。
 */
export function resolveEffectiveAccuracyMode(
  attacker: BattleUnit,
  declaredMode: AccuracyMode,
): AccuracyMode {
  if (declaredMode === "GUARANTEED") {
    return "GUARANTEED";
  }
  return attacker.appliedEffects.some((effect) => effect.statusKind === "GUARANTEED_HIT")
    ? "GUARANTEED"
    : "NORMAL";
}

/**
 * `HitPolicy` (R-HIT-01, R-HIT-02, R-HIT-04). 通常の命中率・回避率は無く、暗闇
 * (R-HIT-03、`resolveEffectSequencePlan`のスキル使用単位ゲートで判定する)や
 * 特別な回避効果(R-HIT-02/R-HIT-04、ここ)が無ければ必ず命中する。
 *
 * R-HIT-02: 攻撃が必中(`accuracyMode: "GUARANTEED"` — 攻撃側定義の指定と、
 * R-HIT-05の必中効果を`resolveEffectiveAccuracyMode`で畳み込んだ実効値の
 * どちらでも成立する)なら回避効果自体を発動させない。対象がチャージ中なら
 * 自身の回避効果を発動させない。対象が持つ有効な回避`AppliedEffect`を付与順
 * （`appliedEffects`の配列順）に判定し、`appliesTo.incomingActionKinds`が指定
 * されていれば`DAMAGE`を含む場合だけ対象、省略時は常に対象とする。
 * `probability`省略時は常に回避する（production定義は常に明示するが、防御的
 * 既定値として1を採用する）。最初に確率判定へ成功した効果が回避を成立させる
 * （判定はRandomSourceを効果ごとに順番に消費する）。
 *
 * R-HIT-04（M7-018、Issue #272）: `status: "HIT_EVASION"`（Nヒット回避）も
 * `status: "EVASION"`とまったく同じ判定を、同じ1本の付与順シーケンスで受ける。
 * production定義（`ACT_ANIS_TROUBLEMAKER_PS1_EVASION`等の`EVASION`と
 * `ACT_FLUTE_VAMPIRE_PS2_EVASION`の`HIT_EVASION`）はどちらもraw原文
 * 「Nヒットだけ攻撃を回避するバフ」を表しており、`14_Catalog定義スキーマ.md`も
 * 両者を「回避」の同一表現として並記する。ヒット数の消費は判定側ではなく
 * `damage-application-service.ts`（回避を成立させたインスタンス自身の
 * `INCOMING_HIT`消費）が担う。
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
    if (effect.statusKind !== "EVASION" && effect.statusKind !== "HIT_EVASION") {
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
