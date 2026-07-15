import type { BattleSimulationCatalogResponseBody } from "./http-contract.js";
import type { BattleSimulationCatalogResult } from "./get-battle-simulation-catalog-use-case.js";

const SCHEMA_VERSION = 1;

/**
 * `10_API設計.md`「戦闘シミュレーション用Catalogレスポンス」: domainの
 * branded ID型（`UnitDefinitionId`等）を持つ`BattleSimulationCatalogResult`
 * から、presentation層が触れてよいプレーンなwire形へ変換する
 * （`simulate-battle-response-mapper.ts`と同じ境界の理由）。
 */
export function toBattleSimulationCatalogResponseBody(
  result: BattleSimulationCatalogResult,
): BattleSimulationCatalogResponseBody {
  return {
    schemaVersion: SCHEMA_VERSION,
    catalogRevision: result.catalogRevision,
    units: result.units.map((unit) => ({
      unitDefinitionId: unit.unitDefinitionId,
      displayName: unit.displayName,
      characterName: unit.characterName,
      attribute: unit.attribute,
      unitType: unit.unitType,
      role: unit.role,
      positionAptitudes: unit.positionAptitudes,
      selectable: unit.selectable,
      unavailableCapabilities: unit.unavailableCapabilities,
    })),
    memories: result.memories.map((memory) => ({
      memoryDefinitionId: memory.memoryDefinitionId,
      displayName: memory.displayName,
      selectable: memory.selectable,
      unavailableCapabilities: memory.unavailableCapabilities,
    })),
  };
}
