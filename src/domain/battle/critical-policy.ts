import type { CriticalMode } from "../catalog/catalog-enums.js";
import type { RandomSource } from "../ports/random-source.js";
import { clampToEffectiveRate, resolveProbability, type Percentage } from "./percentage.js";

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
 * 150%+会心ダメージボーナス、非会心時は常に100%。`baseRate`/`effectiveRate`は
 * modeに関わらず常に算出し、`CriticalCheckResolved`イベントでの監査に使う。
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
    multiplier: isCritical ? 1.5 + criticalDamageBonus : 1,
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
