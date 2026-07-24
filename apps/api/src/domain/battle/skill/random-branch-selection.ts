import type { RandomBranch } from "../../catalog/definitions/effect-sequence.js";
import type { RandomSource } from "../../ports/random-source.js";
import { DomainValidationError } from "../../shared/errors.js";

export interface SelectedRandomBranch {
  readonly branch: RandomBranch;
  readonly branchIndex: number;
}

/**
 * R-SKL-07「RANDOM_BRANCHのWEIGHTED_ONEはweightに応じて1分岐だけを選び」/
 * 「乱数消費順はCatalog定義順とする」。`random.next()`を1回だけ消費し、
 * Catalog定義順の累積weightへ`roll * totalWeight`を対応づける。`weight: 0`の
 * 分岐は累積区間の幅が0のため通常経路では選ばれない。浮動小数点の丸め誤差で
 * 累積が最後まで届かない場合は、最後の到達可能（weight > 0）分岐にfallbackする。
 */
export function selectWeightedBranch(
  branches: readonly RandomBranch[],
  random: RandomSource,
): SelectedRandomBranch {
  const totalWeight = branches.reduce((sum, branch) => sum + (branch.weight ?? 0), 0);
  const roll = random.next() * totalWeight;

  let cumulative = 0;
  for (const [branchIndex, branch] of branches.entries()) {
    cumulative += branch.weight ?? 0;
    if (roll < cumulative) {
      return { branch, branchIndex };
    }
  }

  for (let branchIndex = branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
    const branch = branches[branchIndex];
    if (branch !== undefined && (branch.weight ?? 0) > 0) {
      return { branch, branchIndex };
    }
  }

  throw new DomainValidationError(
    "branches",
    "RANDOM_BRANCH WEIGHTED_ONE requires at least one branch with weight > 0 (Catalog preflight should already guarantee this)",
  );
}
