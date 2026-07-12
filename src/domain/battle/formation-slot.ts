import type { UnitDefinitionId } from "../catalog/catalog-ids.js";
import type { FormationPosition } from "./formation-input.js";
import { toGlobalCoordinate, type GlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";

export interface FormationSlot {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly side: Side;
  readonly position: FormationPosition;
  readonly globalCoordinate: GlobalCoordinate;
}

export function createFormationSlot(
  unitDefinitionId: UnitDefinitionId,
  side: Side,
  position: FormationPosition,
): FormationSlot {
  return {
    unitDefinitionId,
    side,
    position,
    globalCoordinate: toGlobalCoordinate(side, position),
  };
}
