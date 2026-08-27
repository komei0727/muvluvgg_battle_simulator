import type { PositionColumn, PositionRow } from "../../catalog/definitions/catalog-enums.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../catalog/definitions/catalog-ids.js";
import { DomainValidationError } from "../../shared/errors.js";
import { assertEnumValue } from "../../shared/validate.js";
import type { AcademyLevels } from "./academy-level-policy.js";
import type { GearSpecification } from "./gear-customization-policy.js";

const MIN_SLOTS = 1;
const MAX_SLOTS = 5;
const MAX_MEMORY_DEFINITION_IDS = 6;
const POSITION_COLUMNS = ["LEFT", "CENTER", "RIGHT"] as const;
const POSITION_ROWS = ["FRONT", "BACK"] as const;

export interface FormationPosition {
  readonly column: PositionColumn;
  readonly row: PositionRow;
}

/**
 * R-ENH-01 #1: ユニット単位の強化指定（現在レベル・ユニットランク・ギアカスタム）。
 * 値域はCommand検証が保証済みの前提で、`FormationFactory`は算出にだけ使う。
 */
export interface SlotEnhancement {
  readonly level?: number;
  readonly rank?: number;
  readonly gears?: readonly GearSpecification[];
}

/**
 * R-ENH-01 #1/#2: 陣営単位の強化指定（学園レベル）。この指定が**存在すること**が
 * その陣営の全ユニットを強化計算の対象にする条件であり、`academyLevels`を持たない
 * 空オブジェクトでもタイプ装備・モジュール（R-ENH-03）は適用される。
 */
export interface FormationEnhancement {
  readonly academyLevels?: AcademyLevels;
}

export interface FormationSlotInput {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly position: FormationPosition;
  readonly enhancement?: SlotEnhancement;
}

export interface FormationInput {
  readonly slots: readonly FormationSlotInput[];
  readonly memoryDefinitionIds: readonly MemoryDefinitionId[];
  readonly enhancement?: FormationEnhancement;
}

function positionKey(position: FormationPosition): string {
  return `${position.column}:${position.row}`;
}

/**
 * R-FRM-01/02/03/04 at the Domain boundary. R-FRM-03 (same UnitDefinitionId
 * across slots) is intentionally not checked — it is explicitly allowed.
 *
 * `knownMemoryDefinitionIds` is caller-resolved (e.g. from a Catalog
 * snapshot's memory keys) rather than fetched here, so this stays a pure
 * Domain function; only the comparison — not Catalog loading — belongs to
 * the Domain boundary.
 */
export function validateFormationInput(
  input: FormationInput,
  knownMemoryDefinitionIds: ReadonlySet<MemoryDefinitionId>,
  path: string,
): void {
  if (input.slots.length < MIN_SLOTS || input.slots.length > MAX_SLOTS) {
    throw new DomainValidationError(
      `${path}.slots`,
      `must contain between ${MIN_SLOTS} and ${MAX_SLOTS} units, got ${input.slots.length}`,
    );
  }

  const seenPositions = new Set<string>();
  input.slots.forEach((slot, index) => {
    assertEnumValue(
      slot.position.column,
      POSITION_COLUMNS,
      `${path}.slots[${index}].position.column`,
    );
    assertEnumValue(slot.position.row, POSITION_ROWS, `${path}.slots[${index}].position.row`);

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

  input.memoryDefinitionIds.forEach((memoryDefinitionId, index) => {
    if (!knownMemoryDefinitionIds.has(memoryDefinitionId)) {
      throw new DomainValidationError(
        `${path}.memoryDefinitionIds[${index}]`,
        `references an unknown MemoryDefinitionId: "${memoryDefinitionId}"`,
      );
    }
  });
}
