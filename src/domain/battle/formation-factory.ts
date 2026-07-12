import type { Attribute } from "../catalog/catalog-enums.js";
import type { UnitDefinitionId } from "../catalog/catalog-ids.js";
import type { UnitDefinition } from "../catalog/unit-definition.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";
import type { BattleParty, BattlePartyMember } from "./battle-party.js";
import { calculateFormationBonus } from "./formation-bonus-calculator.js";
import type { FormationInput } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";

/**
 * Builds a `BattleParty` from an already-validated `FormationInput`
 * (`R-FRM-01`〜`R-FRM-04`, checked upstream by `validateFormationInput`).
 * `battleUnitIds` is caller-assigned, one per slot in the same order
 * (`09_アプリケーション設計.md`: 参加枠ごとに一意なIDを割り当てるのはApplication層の責務)
 * so the same `UnitDefinitionId` can appear in multiple slots while each
 * slot keeps a distinct `BattleUnitId` (R-FRM-03).
 */
export function createBattleParty(
  side: Side,
  formation: FormationInput,
  battleUnitIds: readonly BattleUnitId[],
  units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  path = "formation",
): BattleParty {
  if (battleUnitIds.length !== formation.slots.length) {
    throw new DomainValidationError(
      `${path}.battleUnitIds`,
      `must contain exactly one BattleUnitId per slot: expected ${formation.slots.length}, got ${battleUnitIds.length}`,
    );
  }

  const members: BattlePartyMember[] = [];
  const attributes: Attribute[] = [];

  formation.slots.forEach((slot, index) => {
    const unitDefinition = units.get(slot.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        `${path}.slots[${index}].unitDefinitionId`,
        `references an unknown UnitDefinitionId: "${slot.unitDefinitionId}"`,
      );
    }

    members.push({
      battleUnitId: battleUnitIds[index]!,
      unitDefinitionId: slot.unitDefinitionId,
      position: slot.position,
      globalCoordinate: toGlobalCoordinate(side, slot.position),
    });
    attributes.push(unitDefinition.attribute);
  });

  return {
    side,
    members,
    memoryDefinitionIds: formation.memoryDefinitionIds,
    formationBonus: calculateFormationBonus(attributes),
  };
}
