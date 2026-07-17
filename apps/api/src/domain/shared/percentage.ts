import type { Brand } from "./brand.js";
import { assertFinite } from "./validate.js";
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

/** R-CRT-01などの「実効◯◯率 = min(100%, max(0%, 元の率))」を共通化する。 */
export function clampToEffectiveRate(rate: Percentage): Percentage {
  return createPercentage(Math.min(1, Math.max(0, rate)));
}

/**
 * R-NUM-03: probability judgment goes through `RandomSource`. `next()`
 * returns a value in [0, 1), so clamping the rate to [0, 1] and comparing
 * with strict `<` guarantees 0% always fails and 100% always succeeds
 * without special-casing either boundary.
 */
export function resolveProbability(rate: Percentage, random: RandomSource): boolean {
  return random.next() < clampToEffectiveRate(rate);
}
