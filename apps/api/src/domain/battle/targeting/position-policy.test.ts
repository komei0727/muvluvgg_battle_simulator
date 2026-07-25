import { describe, expect, it } from "vitest";
import { frontDirectionStep, manhattanDistance } from "./position-policy.js";
import type { GlobalCoordinate } from "../model/global-coordinate.js";
import {
  fc,
  globalCoordinateArb,
  PROPERTY_ASSERT_CONFIG,
} from "../../../testing/property/index.js";

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

/**
 * R-POS-03（マンハッタン距離）の不変条件を property-based test（fast-check）で検証する
 * （`12_テスト戦略.md`「Property／Modelテスト」: ターゲット距離が負にならず、対称性を満たす）。
 */
describe("manhattanDistance properties (R-POS-03)", () => {
  it("PROP-POS-03-001: distance is non-negative and integer", () => {
    fc.assert(
      fc.property(globalCoordinateArb, globalCoordinateArb, (a, b) => {
        const d = manhattanDistance(a, b);
        return d >= 0 && Number.isInteger(d);
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-POS-03-002: distance is symmetric", () => {
    fc.assert(
      fc.property(globalCoordinateArb, globalCoordinateArb, (a, b) => {
        return manhattanDistance(a, b) === manhattanDistance(b, a);
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-POS-03-003: identity of indiscernibles (d(a,a) = 0 and d(a,b) = 0 iff a = b)", () => {
    fc.assert(
      fc.property(globalCoordinateArb, globalCoordinateArb, (a, b) => {
        expect(manhattanDistance(a, a)).toBe(0);
        const equal = a.x === b.x && a.y === b.y;
        return (manhattanDistance(a, b) === 0) === equal;
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-POS-03-004: satisfies the triangle inequality", () => {
    fc.assert(
      fc.property(globalCoordinateArb, globalCoordinateArb, globalCoordinateArb, (a, b, c) => {
        return manhattanDistance(a, c) <= manhattanDistance(a, b) + manhattanDistance(b, c);
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
