import type { CriticalMode } from "../catalog/catalog-enums.js";
import type { RandomSource } from "../ports/random-source.js";
import { resolveProbability, type Percentage } from "./percentage.js";

export interface CriticalResult {
  readonly isCritical: boolean;
  readonly multiplier: number;
}

/**
 * `CriticalPolicy` (R-CRT-01, R-CRT-02). `GUARANTEED`/`PREVENTED` (Catalogの
 * `DamagePayload.critical.mode`) はRandomSourceを消費せず確定する。`NORMAL`は
 * R-NUM-03の`resolveProbability`で実効会心率を判定する。会心倍率は会心時
 * 150%+会心ダメージボーナス、非会心時は常に100%。
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
