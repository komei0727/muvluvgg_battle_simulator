import type { GlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";

/** R-POS-02: 味方の前方はy座標が減る方向、敵の前方はy座標が増える方向とする。 */
const FRONT_STEP: Record<Side, -1 | 1> = {
  ALLY: -1,
  ENEMY: 1,
};

export function frontDirectionStep(side: Side): -1 | 1 {
  return FRONT_STEP[side];
}

/** R-POS-03: `distance = |x1 - x2| + |y1 - y2|` */
export function manhattanDistance(a: GlobalCoordinate, b: GlobalCoordinate): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
