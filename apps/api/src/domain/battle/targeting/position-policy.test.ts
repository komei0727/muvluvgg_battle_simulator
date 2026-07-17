import { describe, expect, it } from "vitest";
import { frontDirectionStep, manhattanDistance } from "./position-policy.js";
import type { GlobalCoordinate } from "../model/global-coordinate.js";

function coord(x: number, y: number): GlobalCoordinate {
  return { x, y };
}

describe("frontDirectionStep — R-POS-02 前方", () => {
  it("UT-R-POS-02-003: ALLY's front is the direction where y decreases", () => {
    expect(frontDirectionStep("ALLY")).toBe(-1);
  });

  it("UT-R-POS-02-004: ENEMY's front is the direction where y increases", () => {
    expect(frontDirectionStep("ENEMY")).toBe(1);
  });
});

describe("manhattanDistance — R-POS-03 距離", () => {
  it("UT-R-POS-03-001: distance to self is 0", () => {
    expect(manhattanDistance(coord(1, 2), coord(1, 2))).toBe(0);
  });

  it("UT-R-POS-03-002: sums the absolute column and row differences", () => {
    expect(manhattanDistance(coord(0, 0), coord(2, 3))).toBe(5);
  });

  it("UT-R-POS-03-003: is symmetric regardless of argument order", () => {
    expect(manhattanDistance(coord(0, 1), coord(2, 3))).toBe(
      manhattanDistance(coord(2, 3), coord(0, 1)),
    );
  });

  it("UT-R-POS-03-004: boundary — two distinct targets tie at the same distance", () => {
    const origin = coord(1, 1);
    expect(manhattanDistance(origin, coord(0, 1))).toBe(1);
    expect(manhattanDistance(origin, coord(1, 0))).toBe(1);
  });

  it("UT-R-POS-03-005: boundary — maximum distance across opposite board corners", () => {
    expect(manhattanDistance(coord(0, 0), coord(2, 3))).toBe(5);
    expect(manhattanDistance(coord(2, 0), coord(0, 3))).toBe(5);
  });
});
