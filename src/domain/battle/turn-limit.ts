import type { Brand } from "../shared/brand.js";
import { assertInteger } from "../shared/validate.js";

/** R-FRM-05: 規定ターン数は1～99の整数とする。 */
export type TurnLimit = Brand<number, "TurnLimit">;
export function createTurnLimit(value: number, path = "turnLimit"): TurnLimit {
  assertInteger(value, path, { min: 1, max: 99 });
  return value as TurnLimit;
}
