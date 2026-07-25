import { describe, expect, it } from "vitest";
import { manhattanDistance } from "./position-policy.js";
import {
  fc,
  globalCoordinateArb,
  PROPERTY_ASSERT_CONFIG,
} from "../../../testing/property/index.js";

/**
 * R-POS-03（マンハッタン距離）の不変条件を property-based test で検証する
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
