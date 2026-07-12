import type { Brand } from "../shared/brand.js";
import { assertFinite } from "../shared/validate.js";
import type { RandomSource } from "../ports/random-source.js";

/**
 * R-NUM-01: 100% is represented internally as 1.0. No upper or lower bound
 * on the raw stat value itself (R-NUM-03) — only `resolveProbability`
 * clamps the *effective* rate used at judgment time.
 */
export type Percentage = Brand<number, "Percentage">;
export function createPercentage(value: number, path = "percentage"): Percentage {
  assertFinite(value, path);
  return value as Percentage;
}

/**
 * R-NUM-03: probability judgment goes through `RandomSource`. `next()`
 * returns a value in [0, 1), so clamping the rate to [0, 1] and comparing
 * with strict `<` guarantees 0% always fails and 100% always succeeds
 * without special-casing either boundary.
 */
export function resolveProbability(rate: Percentage, random: RandomSource): boolean {
  const effectiveRate = Math.min(1, Math.max(0, rate));
  return random.next() < effectiveRate;
}
