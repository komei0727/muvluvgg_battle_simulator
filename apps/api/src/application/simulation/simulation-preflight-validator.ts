import { ApplicationError, type Violation } from "../contracts/application-error.js";
import type { FormationInput, FormationPairCommand } from "./simulate-battle-command.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { DEFAULT_UNIT_LEVEL } from "../../domain/battle/model/enhanced-base-stats-calculator.js";

const FORMATIONS: readonly ["allyFormation", "enemyFormation"] = [
  "allyFormation",
  "enemyFormation",
];

function validateReferences(
  command: FormationPairCommand,
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
 * R-ENH-05 #5: `levelGrowth`を持たないユニットへ200以外の現在レベルを指定した
 * リクエストを拒否する。判定にユニット定義の解決が要るため参照検証と同じ段階で
 * 行うが、クライアントから見れば値の指定ミスなので`INVALID_COMMAND`として返す
 * （`09_アプリケーション設計.md`「Command検証」末尾）。
 */
function validateLevelGrowth(
  command: FormationPairCommand,
  snapshot: BattleCatalogSnapshot,
): Violation[] {
  const violations: Violation[] = [];

  for (const key of FORMATIONS) {
    const formation: FormationInput = command[key];
    formation.slots.forEach((slot, index) => {
      const level = slot.enhancement?.level;
      if (level === undefined || level === DEFAULT_UNIT_LEVEL) {
        return;
      }
      const unitDefinition = snapshot.units.get(slot.unitDefinitionId);
      if (unitDefinition?.levelGrowth === undefined) {
        violations.push({
          path: `${key}.slots[${index}].enhancement.level`,
          definitionId: slot.unitDefinitionId,
          reason: `must be ${DEFAULT_UNIT_LEVEL} because "${slot.unitDefinitionId}" declares no levelGrowth, got ${level}`,
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
export function runPreflight(command: FormationPairCommand, snapshot: BattleCatalogSnapshot): void {
  const referenceViolations = validateReferences(command, snapshot);
  if (referenceViolations.length > 0) {
    // 未解決の参照を先に返す。`levelGrowth`検査は解決済み定義を前提にするため、
    // 存在しないユニットについては「成長値が無い」ではなく参照エラーが正しい。
    throw new ApplicationError("DEFINITION_NOT_FOUND", referenceViolations);
  }

  const levelGrowthViolations = validateLevelGrowth(command, snapshot);
  if (levelGrowthViolations.length > 0) {
    throw new ApplicationError("INVALID_COMMAND", levelGrowthViolations);
  }
}
