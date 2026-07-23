import { DomainValidationError } from "../../shared/errors.js";
import type { RandomSource } from "../../ports/random-source.js";

/**
 * R-SKL-07「`RANDOM_BRANCH`の`WEIGHTED_ONE`はweightに応じて1分岐だけを選ぶ」。
 * `random.next()`（`[0, 1)`）を`weight`の累積合計で線形補間し、1回のRNG消費で
 * 1分岐だけを選ぶ。Catalog検証（`effect-sequence.ts`）が`weight >= 0`と
 * `WEIGHTED_ONE`時の`weight`必須を既に保証しているため、合計0（＝全branchが
 * 到達不能）だけをCatalog記述の不整合として拒否する。
 */
export function selectWeightedBranch<T extends { readonly weight?: number }>(
  branches: readonly T[],
  random: RandomSource,
): T {
  const totalWeight = branches.reduce((sum, branch) => sum + (branch.weight ?? 0), 0);
  if (totalWeight <= 0) {
    throw new DomainValidationError(
      "branches",
      "RANDOM_BRANCH WEIGHTED_ONE requires at least one branch with weight > 0 (Catalog-authoring error: no branch can ever be reached)",
    );
  }
  const roll = random.next() * totalWeight;
  let cumulative = 0;
  for (const branch of branches) {
    cumulative += branch.weight ?? 0;
    if (roll < cumulative) {
      return branch;
    }
  }
  // Floating-point safety net: a roll infinitesimally close to totalWeight
  // (e.g. next() returning a value just under 1) could fail every `<` check
  // above by a rounding hair. Falls back to the last branch, matching the
  // fact that the true mathematical roll always lands within [0, totalWeight).
  const last = branches[branches.length - 1];
  if (last === undefined) {
    throw new DomainValidationError("branches", "must not be empty");
  }
  return last;
}
