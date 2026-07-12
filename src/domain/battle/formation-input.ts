import type { PositionColumn, PositionRow } from "../catalog/catalog-enums.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../catalog/catalog-ids.js";
import { DomainValidationError } from "../shared/errors.js";

const MIN_SLOTS = 1;
const MAX_SLOTS = 5;
const MAX_MEMORY_DEFINITION_IDS = 6;

export interface FormationPosition {
  readonly column: PositionColumn;
  readonly row: PositionRow;
}

export interface FormationSlotInput {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly position: FormationPosition;
}

export interface FormationInput {
  readonly slots: readonly FormationSlotInput[];
  readonly memoryDefinitionIds: readonly MemoryDefinitionId[];
}

function positionKey(position: FormationPosition): string {
  return `${position.column}:${position.row}`;
}

/**
 * R-FRM-01/02/04 at the Domain boundary. R-FRM-03 (same UnitDefinitionId
 * across slots) is intentionally not checked — it is explicitly allowed.
 * Memory ID *existence* (part of R-FRM-04) requires a Catalog snapshot and
 * belongs to the Application-layer SimulationPreflightValidator (M3); only
 * the 0–6 count is validated here.
 */
export function validateFormationInput(input: FormationInput, path: string): void {
  if (input.slots.length < MIN_SLOTS || input.slots.length > MAX_SLOTS) {
    throw new DomainValidationError(
      `${path}.slots`,
      `must contain between ${MIN_SLOTS} and ${MAX_SLOTS} units, got ${input.slots.length}`,
    );
  }

  const seenPositions = new Set<string>();
  input.slots.forEach((slot, index) => {
    const key = positionKey(slot.position);
    if (seenPositions.has(key)) {
      throw new DomainValidationError(
        `${path}.slots[${index}].position`,
        `position ${key} is already occupied within this formation`,
      );
    }
    seenPositions.add(key);
  });

  if (input.memoryDefinitionIds.length > MAX_MEMORY_DEFINITION_IDS) {
    throw new DomainValidationError(
      `${path}.memoryDefinitionIds`,
      `must contain at most ${MAX_MEMORY_DEFINITION_IDS} memory IDs, got ${input.memoryDefinitionIds.length}`,
    );
  }
}
