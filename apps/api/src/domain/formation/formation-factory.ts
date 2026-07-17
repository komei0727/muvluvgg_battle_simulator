import type { Attribute } from "../catalog/definitions/catalog-enums.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../catalog/definitions/memory-definition.js";
import type { UnitDefinition } from "../catalog/definitions/unit-definition.js";
import { DomainValidationError } from "../shared/errors.js";
import type { BattleUnitId } from "../shared/ids.js";
import type { BattleParty, BattlePartyMember } from "../battle/model/battle-party.js";
import {
  calculateFormationBonus,
  type FormationBonus,
} from "../battle/model/formation-bonus-calculator.js";
import type { FormationInput } from "../battle/model/formation-input.js";
import { toGlobalCoordinate } from "../battle/model/global-coordinate.js";
import type { Side } from "../shared/side.js";
import { calculateStartingCombatStats } from "../battle/model/starting-combat-stats.js";

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
 * `memories` is used only to validate that every `formation.memoryDefinitionIds`
 * entry resolves to a known `MemoryDefinition` (R-FRM-*). It does not affect
 * `combatStats`: Memory's `triggeredEffects` (the sole representation of
 * Memory stat correction, `APPLY_STAT_MOD` included) are resolved later by
 * the Memory triggering engine, not by `FormationFactory`
 * (`13_実装計画.md`「スコープ外：Memory triggeredEffectsの解決」).
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

  formation.memoryDefinitionIds.forEach((memoryDefinitionId, index) => {
    if (!memories.has(memoryDefinitionId)) {
      throw new DomainValidationError(
        `${path}.memoryDefinitionIds[${index}]`,
        `references an unknown MemoryDefinitionId: "${memoryDefinitionId}"`,
      );
    }
  });

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
    attribute: unitDefinition.attribute,
    position: slot.position,
    globalCoordinate: toGlobalCoordinate(side, slot.position),
    combatStats: calculateStartingCombatStats({
      baseStats: unitDefinition.baseStats,
      positionAptitudes: unitDefinition.positionAptitudes,
      row: slot.position.row,
      formationBonus,
    }),
  }));

  return {
    side,
    members,
    memoryDefinitionIds: formation.memoryDefinitionIds,
    formationBonus,
  };
}
