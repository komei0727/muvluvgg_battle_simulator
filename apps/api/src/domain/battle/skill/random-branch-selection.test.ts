import { describe, expect, it } from "vitest";
import { selectWeightedBranch } from "./random-branch-selection.js";
import type { RandomBranch } from "../../catalog/definitions/effect-sequence.js";
import type { RandomSource } from "../../ports/random-source.js";

function fixedRandom(...values: number[]): RandomSource {
  let index = 0;
  return {
    next: () => {
      const value = values[index] ?? values[values.length - 1] ?? 0;
      index += 1;
      return value;
    },
  };
}

function branch(weight: number, label: string): RandomBranch {
  return { weight, label, steps: [] };
}

describe("selectWeightedBranch", () => {
  it("UT-RANDOM-BRANCH-001: picks the branch whose cumulative weight range contains the roll", () => {
    const branches = [branch(1, "a"), branch(2, "b"), branch(1, "c")];
    // total = 4. roll * total = 0 -> "a" (range [0,1))
    expect(selectWeightedBranch(branches, fixedRandom(0))).toEqual({
      branch: branches[0],
      branchIndex: 0,
    });
    // roll * total = 1 -> "b" (range [1,3))
    expect(selectWeightedBranch(branches, fixedRandom(0.25))).toEqual({
      branch: branches[1],
      branchIndex: 1,
    });
    // roll * total = 3 -> "c" (range [3,4))
    expect(selectWeightedBranch(branches, fixedRandom(0.75))).toEqual({
      branch: branches[2],
      branchIndex: 2,
    });
  });

  it("UT-RANDOM-BRANCH-002: weight-0 branches are never selected", () => {
    const branches = [branch(0, "unreachable"), branch(1, "only")];
    expect(selectWeightedBranch(branches, fixedRandom(0))).toEqual({
      branch: branches[1],
      branchIndex: 1,
    });
    expect(selectWeightedBranch(branches, fixedRandom(0.999999))).toEqual({
      branch: branches[1],
      branchIndex: 1,
    });
  });

  it("UT-RANDOM-BRANCH-003: consumes exactly one random draw", () => {
    let calls = 0;
    const random: RandomSource = {
      next: () => {
        calls += 1;
        return 0;
      },
    };
    selectWeightedBranch([branch(1, "a"), branch(1, "b")], random);
    expect(calls).toBe(1);
  });

  it("UT-RANDOM-BRANCH-004: floating-point rounding falls back to the last reachable branch", () => {
    const branches = [branch(0.1, "a"), branch(0.2, "b")];
    // A roll infinitesimally below 1 (the theoretical max of random.next()) combined with
    // floating-point summation error can leave the walk short of the last branch's upper
    // bound; the selection must still resolve to a reachable (weight > 0) branch.
    expect(selectWeightedBranch(branches, fixedRandom(0.9999999999999999)).branch).toBe(
      branches[1],
    );
  });
});
