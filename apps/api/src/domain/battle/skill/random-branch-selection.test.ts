import { describe, expect, it } from "vitest";
import { selectWeightedBranch } from "./random-branch-selection.js";
import { DomainValidationError } from "../../shared/errors.js";
import type { RandomSource } from "../../ports/random-source.js";

function fixedRandom(...values: readonly number[]): RandomSource {
  let index = 0;
  return {
    next(): number {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error("fixedRandom exhausted");
      }
      return value;
    },
  };
}

describe("selectWeightedBranch", () => {
  const branches = [
    { label: "A", weight: 1, steps: [] },
    { label: "B", weight: 3, steps: [] },
  ];

  it("UT-RANDOM-BRANCH-001 (R-SKL-07): a roll landing in the first branch's cumulative range selects it", () => {
    // totalWeight = 4; roll = next() * 4. next()=0 -> roll=0 -> falls in [0,1) => branch A.
    expect(selectWeightedBranch(branches, fixedRandom(0))).toBe(branches[0]);
  });

  it("UT-RANDOM-BRANCH-002 (R-SKL-07): a roll landing past the first branch's cumulative weight selects the next branch", () => {
    // next()=0.5 -> roll=2 -> falls in [1,4) => branch B.
    expect(selectWeightedBranch(branches, fixedRandom(0.5))).toBe(branches[1]);
  });

  it("UT-RANDOM-BRANCH-003 (R-SKL-07, boundary): a roll just below the total weight still selects the last branch", () => {
    // next() just under 1 -> roll just under 4 -> still branch B.
    expect(selectWeightedBranch(branches, fixedRandom(0.999999))).toBe(branches[1]);
  });

  it("UT-RANDOM-BRANCH-004 (boundary): zero total weight is a Catalog-authoring error, not a legitimate runtime state", () => {
    const zeroWeightBranches = [{ label: "A", weight: 0, steps: [] }];
    expect(() => selectWeightedBranch(zeroWeightBranches, fixedRandom(0))).toThrow(
      DomainValidationError,
    );
  });
});
