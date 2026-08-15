import { describe, expect, it } from "vitest";
import { compareActionOrder, sortByActionOrder } from "./action-order-policy.js";
import {
  createBattleUnit,
  type BattleUnit,
  type BattleUnitResourceLimits,
} from "../model/battle-unit.js";
import type { BattlePartyMember } from "../model/battle-party.js";
import { createBattleUnitId } from "../../shared/ids.js";
import { createUnitDefinitionId } from "../../catalog/definitions/catalog-ids.js";
import type { FormationPosition } from "../model/formation-input.js";
import { toGlobalCoordinate } from "../model/global-coordinate.js";
import {
  battleUnitArb,
  distinctPositionUnitsArb,
  fc,
  PROPERTY_ASSERT_CONFIG,
} from "../../../testing/property/index.js";
import type { Side } from "../../shared/side.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../../../testing/fixtures/battle-actors.js";

const LIMITS: BattleUnitResourceLimits = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 };

function unit(
  id: string,
  side: Side,
  position: FormationPosition,
  actionSpeed: number,
): BattleUnit {
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, side, LIMITS);
}

describe("compareActionOrder", () => {
  it("UT-R-ORD-02-001: higher action speed sorts first", () => {
    const fast = unit("FAST", "ALLY", { column: "LEFT", row: "FRONT" }, 20);
    const slow = unit("SLOW", "ALLY", { column: "LEFT", row: "FRONT" }, 10);

    expect(compareActionOrder(fast, slow)).toBeLessThan(0);
    expect(compareActionOrder(slow, fast)).toBeGreaterThan(0);
  });

  it("UT-R-ORD-02-002: same speed sorts ALLY before ENEMY", () => {
    const ally = unit("ALLY_1", "ALLY", { column: "LEFT", row: "FRONT" }, 10);
    const enemy = unit("ENEMY_1", "ENEMY", { column: "LEFT", row: "FRONT" }, 10);

    expect(compareActionOrder(ally, enemy)).toBeLessThan(0);
    expect(compareActionOrder(enemy, ally)).toBeGreaterThan(0);
  });

  it("UT-R-ORD-02-003: same speed and side sorts FRONT before BACK", () => {
    const front = unit("FRONT_1", "ALLY", { column: "LEFT", row: "FRONT" }, 10);
    const back = unit("BACK_1", "ALLY", { column: "LEFT", row: "BACK" }, 10);

    expect(compareActionOrder(front, back)).toBeLessThan(0);
    expect(compareActionOrder(back, front)).toBeGreaterThan(0);
  });

  it("UT-R-ORD-02-004: same speed, side, and row sorts by absolute left-to-right column", () => {
    const left = unit("LEFT_1", "ALLY", { column: "LEFT", row: "FRONT" }, 10);
    const center = unit("CENTER_1", "ALLY", { column: "CENTER", row: "FRONT" }, 10);
    const right = unit("RIGHT_1", "ALLY", { column: "RIGHT", row: "FRONT" }, 10);

    expect(compareActionOrder(left, center)).toBeLessThan(0);
    expect(compareActionOrder(center, right)).toBeLessThan(0);
    expect(compareActionOrder(left, right)).toBeLessThan(0);
  });
});

describe("sortByActionOrder", () => {
  it("UT-R-ORD-02-005 / SCN-BTL-002: full same-speed roster resolves ally-then-enemy, front-then-back, left-to-right", () => {
    const roster = [
      unit("ALLY_BACK_RIGHT", "ALLY", { column: "RIGHT", row: "BACK" }, 10),
      unit("ENEMY_FRONT_LEFT", "ENEMY", { column: "LEFT", row: "FRONT" }, 10),
      unit("ALLY_FRONT_LEFT", "ALLY", { column: "LEFT", row: "FRONT" }, 10),
      unit("ALLY_FRONT_RIGHT", "ALLY", { column: "RIGHT", row: "FRONT" }, 10),
      unit("ENEMY_BACK_LEFT", "ENEMY", { column: "LEFT", row: "BACK" }, 10),
    ];

    const ordered = sortByActionOrder(roster).map((u) => u.battleUnitId);

    expect(ordered).toEqual(
      [
        "ALLY_FRONT_LEFT",
        "ALLY_FRONT_RIGHT",
        "ALLY_BACK_RIGHT",
        "ENEMY_FRONT_LEFT",
        "ENEMY_BACK_LEFT",
      ].map((id) => createBattleUnitId(id)),
    );
  });

  it("UT-R-ORD-02-006: input order does not affect the resolved order (determinism)", () => {
    const roster = [
      unit("ALLY_BACK_RIGHT", "ALLY", { column: "RIGHT", row: "BACK" }, 10),
      unit("ENEMY_FRONT_LEFT", "ENEMY", { column: "LEFT", row: "FRONT" }, 10),
      unit("ALLY_FRONT_LEFT", "ALLY", { column: "LEFT", row: "FRONT" }, 10),
      unit("ALLY_FRONT_RIGHT", "ALLY", { column: "RIGHT", row: "FRONT" }, 10),
      unit("ENEMY_BACK_LEFT", "ENEMY", { column: "LEFT", row: "BACK" }, 10),
    ];
    const shuffled = [roster[4]!, roster[1]!, roster[3]!, roster[0]!, roster[2]!];

    const orderedFromOriginal = sortByActionOrder(roster).map((u) => u.battleUnitId);
    const orderedFromShuffled = sortByActionOrder(shuffled).map((u) => u.battleUnitId);

    expect(orderedFromShuffled).toEqual(orderedFromOriginal);
  });

  it("UT-R-ORD-02-007: does not mutate the input array", () => {
    const roster = [
      unit("SLOW", "ALLY", { column: "LEFT", row: "FRONT" }, 5),
      unit("FAST", "ALLY", { column: "RIGHT", row: "FRONT" }, 20),
    ];
    const originalOrder = roster.map((u) => u.battleUnitId);

    sortByActionOrder(roster);

    expect(roster.map((u) => u.battleUnitId)).toEqual(originalOrder);
  });
});

const sign = (n: number): number => Math.sign(n);

/**
 * R-ORD-02（行動順比較器）の代数法則を property-based test（fast-check）で検証する
 * （`12_テスト戦略.md`「Property／Modelテスト」: 反対称性・推移律・決定性、入力配列順を
 * 変えても結果順が変わらないこと。入力配列順を暗黙のtie-breakerにしない）。
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
