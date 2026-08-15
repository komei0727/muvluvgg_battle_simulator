import type { CriticalMode } from "../../catalog/definitions/catalog-enums.js";
import type { RandomSource } from "../../ports/random-source.js";
import {
  clampToEffectiveRate,
  resolveProbability,
  type Percentage,
} from "../../shared/percentage.js";
import type { BattleUnit } from "../model/battle-unit.js";

/**
 * R-CRT-03「会心保証・会心不可」（DMG-003A、Issue #295）: 使用者が保持する会心状態
 * 効果（`APPLY_STATUS`の`status: "CRITICAL_GUARANTEE"`/`"CRITICAL_PREVENTION"`）を、
 * そのDAMAGE定義が宣言する`critical.mode`へ畳み込んで実効会心モードを返す。
 * 呼び出し側はこの実効値を`resolveCritical`と`CriticalCheckResolved`の両方へ渡す。
 *
 * どちらの効果も**保持者自身の攻撃**に働く（raw原文の「攻撃が必ず会心攻撃になる
 * バフ」＝自身へ付与、「会心不可のデバフ」＝攻撃した敵へ付与し、その敵の攻撃を
 * 会心させない）。R-HIT-05の`GUARANTEED_HIT`とまったく同じ「保持者の攻撃側に働く」
 * 規約であり、防御側の保持は参照しない — この関数が防御側を引数に取らないことで
 * 構造的に保証する。
 *
 * `PREVENTED`が`GUARANTEED`より強いのは、会心不可が会心の発生自体を禁じる制限で
 * あり会心保証は発生を確定させる緩和にすぎないためである。この順序は同時に、会心の
 * 項を持たないサブユニット追加ダメージ（R-SUB-02の`PREVENTED`固定）が使用者の会心
 * 保証で会心し始めることも防ぐ。
 */
export function resolveEffectiveCriticalMode(
  attacker: BattleUnit,
  declaredMode: CriticalMode,
): CriticalMode {
  if (
    declaredMode === "PREVENTED" ||
    attacker.appliedEffects.some((effect) => effect.statusKind === "CRITICAL_PREVENTION")
  ) {
    return "PREVENTED";
  }
  if (
    declaredMode === "GUARANTEED" ||
    attacker.appliedEffects.some((effect) => effect.statusKind === "CRITICAL_GUARANTEE")
  ) {
    return "GUARANTEED";
  }
  return "NORMAL";
}

export interface CriticalResult {
  readonly isCritical: boolean;
  readonly multiplier: number;
  /** 元会心率（クランプ前、`CombatStats.criticalRate`そのもの）。 */
  readonly baseRate: Percentage;
  /** 実効会心率（R-CRT-01: `min(100%, max(0%, 元会心率))`）。 */
  readonly effectiveRate: Percentage;
}

/**
 * `CriticalPolicy` (R-CRT-01, R-CRT-02). `GUARANTEED`/`PREVENTED` (Catalogの
 * `DamagePayload.critical.mode`) はRandomSourceを消費せず確定する。`NORMAL`は
 * R-NUM-03の`resolveProbability`で実効会心率を判定する。会心倍率は会心時
 * 100%+会心ダメージボーナス、非会心時は常に100%。`baseRate`/`effectiveRate`は
 * modeに関わらず常に算出し、`CriticalCheckResolved`イベントでの監査に使う。
 *
 * 基準が150%ではなく100%なのは、`criticalDamageBonus`が既定値50%（Q-CAT-05）を
 * 含んだユニットステータスだからである（R-ENH-06のギア加算・R-STA-01の戦闘中補正も
 * この値へパーセントポイントで足し込む）。R-CRT-02が挙げる「150%」は既定値込みの
 * 結果であり、ここで別途150%を足すと既定値が二重に乗る。
 */
export function resolveCritical(
  mode: CriticalMode,
  criticalRate: Percentage,
  criticalDamageBonus: number,
  random: RandomSource,
): CriticalResult {
  const isCritical = resolveIsCritical(mode, criticalRate, random);
  return {
    isCritical,
    multiplier: isCritical ? 1 + criticalDamageBonus : 1,
    baseRate: criticalRate,
    effectiveRate: clampToEffectiveRate(criticalRate),
  };
}

function resolveIsCritical(
  mode: CriticalMode,
  criticalRate: Percentage,
  random: RandomSource,
): boolean {
  switch (mode) {
    case "GUARANTEED":
      return true;
    case "PREVENTED":
      return false;
    case "NORMAL":
      return resolveProbability(criticalRate, random);
  }
}
