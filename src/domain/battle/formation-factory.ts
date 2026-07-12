import type { Attribute } from "../catalog/catalog-enums.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../catalog/catalog-ids.js";
import type { MemoryDefinition, MemoryModifier } from "../catalog/memory-definition.js";
import type { UnitDefinition } from "../catalog/unit-definition.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";
import type { BattleParty, BattlePartyMember } from "./battle-party.js";
import { calculateFormationBonus, type FormationBonus } from "./formation-bonus-calculator.js";
import type { FormationInput } from "./formation-input.js";
import { toGlobalCoordinate } from "./global-coordinate.js";
import type { Side } from "./side.js";
import { calculateStartingCombatStats } from "./starting-combat-stats.js";

/**
 * Builds a `BattleParty` from an already-validated `FormationInput`
 * (`R-FRM-01`〜`R-FRM-04`, checked upstream by `validateFormationInput`).
 * `battleUnitIds` is caller-assigned, one per slot in the same order
 * (`09_アプリケーション設計.md`: 参加枠ごとに一意なIDを割り当てるのはApplication層の責務).
 * The same `UnitDefinitionId` can appear in multiple slots, but each slot
 * must keep a distinct `BattleUnitId` (R-FRM-03) — a duplicate is rejected
 * rather than silently collapsing two participants' HP/skill/effect/event
 * ownership onto one id.
 *
 * `memories` resolves `formation.memoryDefinitionIds` into their `modifiers`
 * (R-STA-01), which apply uniformly to every member's starting `combatStats`
 * since `MemoryModifier.targetFilter` currently only supports `ALL`.
 */
export function createBattleParty(
  side: Side,
  formation: FormationInput,
  battleUnitIds: readonly BattleUnitId[],
  units: ReadonlyMap<UnitDefinitionId, UnitDefinition>,
  memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>,
  path = "formation",
): BattleParty {
  if (battleUnitIds.length !== formation.slots.length) {
    throw new DomainValidationError(
      `${path}.battleUnitIds`,
      `must contain exactly one BattleUnitId per slot: expected ${formation.slots.length}, got ${battleUnitIds.length}`,
    );
  }

  const seenBattleUnitIds = new Set<BattleUnitId>();
  battleUnitIds.forEach((battleUnitId, index) => {
    if (seenBattleUnitIds.has(battleUnitId)) {
      throw new DomainValidationError(
        `${path}.battleUnitIds[${index}]`,
        `duplicates a BattleUnitId already assigned to another slot: "${battleUnitId}"`,
      );
    }
    seenBattleUnitIds.add(battleUnitId);
  });

  const memoryModifiers: MemoryModifier[] = formation.memoryDefinitionIds.flatMap(
    (memoryDefinitionId, index) => {
      const memory = memories.get(memoryDefinitionId);
      if (memory === undefined) {
        throw new DomainValidationError(
          `${path}.memoryDefinitionIds[${index}]`,
          `references an unknown MemoryDefinitionId: "${memoryDefinitionId}"`,
        );
      }
      return memory.modifiers;
    },
  );

  const slotUnits = formation.slots.map((slot, index) => {
    const unitDefinition = units.get(slot.unitDefinitionId);
    if (unitDefinition === undefined) {
      throw new DomainValidationError(
        `${path}.slots[${index}].unitDefinitionId`,
        `references an unknown UnitDefinitionId: "${slot.unitDefinitionId}"`,
      );
    }
    return { slot, unitDefinition };
  });

  const attributes: Attribute[] = slotUnits.map(({ unitDefinition }) => unitDefinition.attribute);
  const formationBonus: FormationBonus = calculateFormationBonus(attributes);

  const members: BattlePartyMember[] = slotUnits.map(({ slot, unitDefinition }, index) => ({
    battleUnitId: battleUnitIds[index]!,
    unitDefinitionId: slot.unitDefinitionId,
    position: slot.position,
    globalCoordinate: toGlobalCoordinate(side, slot.position),
    combatStats: calculateStartingCombatStats({
      baseStats: unitDefinition.baseStats,
      positionAptitudes: unitDefinition.positionAptitudes,
      row: slot.position.row,
      formationBonus,
      memoryModifiers,
    }),
  }));

  return {
    side,
    members,
    memoryDefinitionIds: formation.memoryDefinitionIds,
    formationBonus,
  };
}
