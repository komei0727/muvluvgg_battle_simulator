import type { PositionColumn, PositionRow } from "../../catalog/definitions/catalog-enums.js";
import { assertInteger } from "../../shared/validate.js";
import type { FormationPosition } from "./formation-input.js";
import type { Side } from "../../shared/side.js";

export interface GlobalCoordinate {
  readonly x: number;
  readonly y: number;
}

const MIN_X = 0;
const MAX_X = 2;
const MIN_Y = 0;
const MAX_Y = 3;

/** R-POS-01: `x=0..2`, `y=0..3` (`05_ドメインモデル.md` の値オブジェクト表)。 */
export function createGlobalCoordinate(
  x: number,
  y: number,
  path = "globalCoordinate",
): GlobalCoordinate {
  assertInteger(x, `${path}.x`, { min: MIN_X, max: MAX_X });
  assertInteger(y, `${path}.y`, { min: MIN_Y, max: MAX_Y });
  return { x, y };
}

/** R-POS-02: 絶対左列は陣営の向きにかかわらずx座標が小さい側とする。 */
const COLUMN_X: Record<PositionColumn, number> = {
  LEFT: 0,
  CENTER: 1,
  RIGHT: 2,
};

/** R-POS-01: 敵後列、敵前列、味方前列、味方後列の順にyを割り当てる。 */
const ROW_Y: Record<Side, Record<PositionRow, number>> = {
  ENEMY: { BACK: 0, FRONT: 1 },
  ALLY: { FRONT: 2, BACK: 3 },
};

export function toGlobalCoordinate(side: Side, position: FormationPosition): GlobalCoordinate {
  return createGlobalCoordinate(COLUMN_X[position.column], ROW_Y[side][position.row]);
}
