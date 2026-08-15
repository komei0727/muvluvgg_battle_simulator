import * as fc from "fast-check";
import { createBattleUnit, type BattleUnit } from "../../domain/battle/model/battle-unit.js";
import type { BattlePartyMember } from "../../domain/battle/model/battle-party.js";
import type { FormationPosition } from "../../domain/battle/model/formation-input.js";
import {
  createGlobalCoordinate,
  toGlobalCoordinate,
  type GlobalCoordinate,
} from "../../domain/battle/model/global-coordinate.js";
import { createBattleUnitId } from "../../domain/shared/ids.js";
import { createUnitDefinitionId } from "../../domain/catalog/definitions/catalog-ids.js";
import type { Side } from "../../domain/shared/side.js";
import { UNUSED_ENHANCED_BASE_STATS } from "../fixtures/battle-actors.js";

/**
 * Property/Model テストの共通設定（`12_テスト戦略.md`「Property／Modelテスト」）。
 * seed を固定してCIを決定的にし、失敗時に fast-check が seed と最小反例を出力する。
 * ドメイン上有効な入力を基本とし、無効入力生成器は値オブジェクト・Command検証用に分ける。
 */
export const PROPERTY_ASSERT_CONFIG: fc.Parameters<unknown> = {
  seed: 0x5eed,
  numRuns: 200,
};

const COLUMNS = ["LEFT", "CENTER", "RIGHT"] as const;
const ROWS = ["FRONT", "BACK"] as const;
const SIDES = ["ALLY", "ENEMY"] as const;

/** 有効な共通座標（x∈0..2, y∈0..3）。 */
export const globalCoordinateArb: fc.Arbitrary<GlobalCoordinate> = fc
  .record({ x: fc.integer({ min: 0, max: 2 }), y: fc.integer({ min: 0, max: 3 }) })
  .map(({ x, y }) => createGlobalCoordinate(x, y));

export const sideArb: fc.Arbitrary<Side> = fc.constantFrom(...SIDES);
export const positionArb: fc.Arbitrary<FormationPosition> = fc.record({
  column: fc.constantFrom(...COLUMNS),
  row: fc.constantFrom(...ROWS),
});

const RESOURCE_LIMITS = { maximumAp: 3, maximumPp: 3, maximumExtraGauge: 100 } as const;

interface UnitPlacement {
  readonly id: string;
  readonly side: Side;
  readonly position: FormationPosition;
  readonly actionSpeed: number;
}

/** `UnitPlacement` から実 `BattleUnit` を構築する（action-order-policy.test.ts と同じ経路）。 */
export function battleUnitFromPlacement(placement: UnitPlacement): BattleUnit {
  const member: BattlePartyMember = {
    enhancedBaseStats: UNUSED_ENHANCED_BASE_STATS,
    battleUnitId: createBattleUnitId(placement.id),
    unitDefinitionId: createUnitDefinitionId("UNIT_001"),
    attribute: "AGGRESSIVE",
    position: placement.position,
    globalCoordinate: toGlobalCoordinate(placement.side, placement.position),
    combatStats: {
      maximumHp: 100,
      attack: 10,
      defense: 10,
      criticalRate: 0.1,
      actionSpeed: placement.actionSpeed,
      criticalDamageBonus: 0.5,
      affinityBonus: 0.25,
    },
  };
  return createBattleUnit(member, placement.side, RESOURCE_LIMITS);
}

/** 任意の（位置が重複しうる）BattleUnit。比較器の代数法則の検証に使う。 */
export const battleUnitArb: fc.Arbitrary<BattleUnit> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)),
    side: sideArb,
    position: positionArb,
    actionSpeed: fc.integer({ min: 0, max: 100 }),
  })
  .map(battleUnitFromPlacement);

const ALL_PLACEMENTS: readonly { side: Side; position: FormationPosition }[] = SIDES.flatMap(
  (side) => COLUMNS.flatMap((column) => ROWS.map((row) => ({ side, position: { column, row } }))),
);

/**
 * 位置が互いに異なるBattleUnitの配列。位置が異なれば比較器はタイにならないため
 * （速度が同値でも side/row/x のいずれかで一意に決まる）、入力順非依存性を厳密に検証できる。
 */
export const distinctPositionUnitsArb: fc.Arbitrary<readonly BattleUnit[]> = fc
  .uniqueArray(fc.integer({ min: 0, max: ALL_PLACEMENTS.length - 1 }), {
    minLength: 2,
    maxLength: ALL_PLACEMENTS.length,
  })
  .chain((indices) =>
    fc
      .array(fc.integer({ min: 0, max: 100 }), {
        minLength: indices.length,
        maxLength: indices.length,
      })
      .map((speeds) =>
        indices.map((placementIndex, i) => {
          const placement = ALL_PLACEMENTS[placementIndex]!;
          return battleUnitFromPlacement({
            id: `U${placementIndex}`,
            side: placement.side,
            position: placement.position,
            actionSpeed: speeds[i]!,
          });
        }),
      ),
  );

export { fc };
