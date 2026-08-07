import { ApplicationError, type Violation } from "../contracts/application-error.js";
import type { FormationInput, SimulateBattleCommand } from "./simulate-battle-command.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";

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

/**
 * `09_アプリケーション設計.md` の SimulationPreflightValidator: 参照検証を
 * 行う（Command検証はUseCaseが `validateCommandShape` を直接呼ぶため、
 * ここでは扱わない）。
 */
export function runPreflight(
  command: SimulateBattleCommand,
  snapshot: BattleCatalogSnapshot,
): void {
  const referenceViolations = validateReferences(command, snapshot);
  if (referenceViolations.length > 0) {
    throw new ApplicationError("DEFINITION_NOT_FOUND", referenceViolations);
  }
}
