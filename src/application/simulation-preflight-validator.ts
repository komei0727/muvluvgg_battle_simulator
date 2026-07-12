import { ApplicationError, type Violation } from "./application-error.js";
import type { FormationInput, SimulateBattleCommand } from "./simulate-battle-command.js";
import {
  collectRequiredCapabilities,
  findUnimplementedCapabilities,
} from "../domain/catalog/capability-availability.js";
import type { MemoryDefinitionId, UnitDefinitionId } from "../domain/catalog/catalog-ids.js";
import type { BattleCatalogSnapshot } from "../domain/ports/battle-catalog.js";

const FORMATIONS: readonly ["allyFormation", "enemyFormation"] = [
  "allyFormation",
  "enemyFormation",
];

function validateReferences(
  command: SimulateBattleCommand,
  snapshot: BattleCatalogSnapshot,
): Violation[] {
  const violations: Violation[] = [];

  for (const key of FORMATIONS) {
    const formation: FormationInput = command[key];
    formation.slots.forEach((slot, index) => {
      if (!snapshot.units.has(slot.unitDefinitionId)) {
        violations.push({
          path: `${key}.slots[${index}].unitDefinitionId`,
          definitionId: slot.unitDefinitionId,
          reason: `references an unknown UnitDefinitionId: "${slot.unitDefinitionId}"`,
        });
      }
    });
    formation.memoryDefinitionIds.forEach((memoryDefinitionId, index) => {
      if (!snapshot.memories.has(memoryDefinitionId)) {
        violations.push({
          path: `${key}.memoryDefinitionIds[${index}]`,
          definitionId: memoryDefinitionId,
          reason: `references an unknown MemoryDefinitionId: "${memoryDefinitionId}"`,
        });
      }
    });
  }

  return violations;
}

function collectReferencedIds(command: SimulateBattleCommand): {
  unitDefinitionIds: UnitDefinitionId[];
  memoryDefinitionIds: MemoryDefinitionId[];
} {
  const unitDefinitionIds = new Set<UnitDefinitionId>();
  const memoryDefinitionIds = new Set<MemoryDefinitionId>();

  for (const key of FORMATIONS) {
    const formation: FormationInput = command[key];
    for (const slot of formation.slots) {
      unitDefinitionIds.add(slot.unitDefinitionId);
    }
    for (const memoryDefinitionId of formation.memoryDefinitionIds) {
      memoryDefinitionIds.add(memoryDefinitionId);
    }
  }

  return {
    unitDefinitionIds: [...unitDefinitionIds],
    memoryDefinitionIds: [...memoryDefinitionIds],
  };
}

/**
 * `09_アプリケーション設計.md` の SimulationPreflightValidator: 参照検証と
 * R-FRM-06 Capability preflightを行う（Command検証はUseCaseが
 * `validateCommandShape` を直接呼ぶため、ここでは扱わない）。
 */
export function runPreflight(
  command: SimulateBattleCommand,
  snapshot: BattleCatalogSnapshot,
): void {
  const referenceViolations = validateReferences(command, snapshot);
  if (referenceViolations.length > 0) {
    throw new ApplicationError("DEFINITION_NOT_FOUND", referenceViolations);
  }

  const { unitDefinitionIds, memoryDefinitionIds } = collectReferencedIds(command);
  const required = collectRequiredCapabilities(snapshot, unitDefinitionIds, memoryDefinitionIds);
  const unimplemented = findUnimplementedCapabilities(required, snapshot.capabilities);
  if (unimplemented.length > 0) {
    throw new ApplicationError(
      "UNSUPPORTED_RULE",
      unimplemented.map((capabilityId) => ({
        ruleId: capabilityId,
        reason: `requires unimplemented capability "${capabilityId}"`,
      })),
    );
  }
}
