import { describe, expect, it } from "vitest";
import { compareActionOrder, sortByActionOrder } from "./action-order-policy.js";
import {
  battleUnitArb,
  distinctPositionUnitsArb,
  fc,
  PROPERTY_ASSERT_CONFIG,
} from "../../../testing/property/index.js";

const sign = (n: number): number => Math.sign(n);

/**
 * R-ORD-02（行動順比較器）の代数法則を property-based test で検証する
 * （`12_テスト戦略.md`「Property／Modelテスト」: 反対称性・推移律・決定性、
 * 入力配列順を変えても結果順が変わらないこと。入力配列順を暗黙のtie-breakerにしない）。
 */
describe("compareActionOrder properties (R-ORD-02)", () => {
  it("PROP-ORD-02-001: is deterministic (same inputs give the same sign)", () => {
    fc.assert(
      fc.property(battleUnitArb, battleUnitArb, (a, b) => {
        return sign(compareActionOrder(a, b)) === sign(compareActionOrder(a, b));
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ORD-02-002: is antisymmetric (sign(cmp(a,b)) === -sign(cmp(b,a)))", () => {
    fc.assert(
      fc.property(battleUnitArb, battleUnitArb, (a, b) => {
        return sign(compareActionOrder(a, b)) === -sign(compareActionOrder(b, a));
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ORD-02-003: is transitive (a<=b and b<=c imply a<=c)", () => {
    fc.assert(
      fc.property(battleUnitArb, battleUnitArb, battleUnitArb, (a, b, c) => {
        if (compareActionOrder(a, b) <= 0 && compareActionOrder(b, c) <= 0) {
          return compareActionOrder(a, c) <= 0;
        }
        return true;
      }),
      PROPERTY_ASSERT_CONFIG,
    );
  });

  it("PROP-ORD-02-004: sort order is independent of input array order (no implicit tie-breaker)", () => {
    fc.assert(
      fc.property(
        distinctPositionUnitsArb.chain((units) =>
          fc.shuffledSubarray([...units], { minLength: units.length }).map((shuffled) => ({
            units,
            shuffled,
          })),
        ),
        ({ units, shuffled }) => {
          const fromOriginal = sortByActionOrder(units).map((u) => String(u.battleUnitId));
          const fromShuffled = sortByActionOrder(shuffled).map((u) => String(u.battleUnitId));
          expect(fromShuffled).toEqual(fromOriginal);
        },
      ),
      PROPERTY_ASSERT_CONFIG,
    );
  });
});
