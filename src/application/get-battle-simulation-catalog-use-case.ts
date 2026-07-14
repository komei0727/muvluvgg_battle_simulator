import {
  collectRequiredCapabilities,
  findUnimplementedCapabilities,
} from "../domain/catalog/capability-availability.js";
import type { Attribute, PositionRow, Role, UnitType } from "../domain/catalog/catalog-enums.js";
import type {
  CapabilityId,
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../domain/catalog/catalog-ids.js";
import type { MemoryDefinition } from "../domain/catalog/memory-definition.js";
import type { UnitDefinition } from "../domain/catalog/unit-definition.js";
import type { BattleCatalogDirectory } from "../domain/ports/battle-catalog-directory.js";
import type { BattleCatalogSnapshot } from "../domain/ports/battle-catalog.js";

export interface BattleSimulationUnitSummary {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly displayName: string;
  readonly characterName: string;
  readonly attribute: Attribute;
  readonly unitType: UnitType;
  readonly role: Role;
  readonly positionAptitudes: readonly PositionRow[];
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly CapabilityId[];
}

export interface BattleSimulationMemorySummary {
  readonly memoryDefinitionId: MemoryDefinitionId;
  readonly displayName: string;
  readonly selectable: boolean;
  readonly unavailableCapabilities: readonly CapabilityId[];
}

export interface BattleSimulationCatalogResult {
  readonly catalogRevision: string;
  readonly units: readonly BattleSimulationUnitSummary[];
  readonly memories: readonly BattleSimulationMemorySummary[];
}

export interface GetBattleSimulationCatalogUseCaseDependencies {
  readonly battleCatalogDirectory: BattleCatalogDirectory;
}

function unavailableCapabilitiesOf(
  snapshot: BattleCatalogSnapshot,
  unitDefinitionIds: readonly UnitDefinitionId[],
  memoryDefinitionIds: readonly MemoryDefinitionId[],
): readonly CapabilityId[] {
  const required = collectRequiredCapabilities(snapshot, unitDefinitionIds, memoryDefinitionIds);
  const unimplemented = findUnimplementedCapabilities(required, snapshot.capabilities);
  return unimplemented.map((entry) => entry.capabilityId).sort((a, b) => a.localeCompare(b));
}

function projectUnit(
  unit: UnitDefinition,
  snapshot: BattleCatalogSnapshot,
): BattleSimulationUnitSummary {
  const unavailableCapabilities = unavailableCapabilitiesOf(snapshot, [unit.unitDefinitionId], []);
  return {
    unitDefinitionId: unit.unitDefinitionId,
    displayName: unit.metadata.displayName,
    characterName: unit.metadata.characterName,
    attribute: unit.attribute,
    unitType: unit.unitType,
    role: unit.role,
    positionAptitudes: unit.positionAptitudes,
    selectable: unavailableCapabilities.length === 0,
    unavailableCapabilities,
  };
}

function projectMemory(
  memory: MemoryDefinition,
  snapshot: BattleCatalogSnapshot,
): BattleSimulationMemorySummary {
  const unavailableCapabilities = unavailableCapabilitiesOf(
    snapshot,
    [],
    [memory.memoryDefinitionId],
  );
  return {
    memoryDefinitionId: memory.memoryDefinitionId,
    displayName: memory.metadata.displayName,
    selectable: unavailableCapabilities.length === 0,
    unavailableCapabilities,
  };
}

/**
 * `09_アプリケーション設計.md` の `GetBattleSimulationCatalogUseCase`:
 * `BattleCatalogDirectory`から取得した検証済みスナップショットを、
 * `SimulationPreflightValidator`と同じ `collectRequiredCapabilities`/
 * `findUnimplementedCapabilities` で選択可否projectionする。Skill、
 * EffectAction、Formula、Condition、triggeredEffectsの完全定義は
 * Resultへ公開しない。
 */
export class GetBattleSimulationCatalogUseCase {
  private readonly battleCatalogDirectory: BattleCatalogDirectory;

  constructor(dependencies: GetBattleSimulationCatalogUseCaseDependencies) {
    this.battleCatalogDirectory = dependencies.battleCatalogDirectory;
  }

  execute(): BattleSimulationCatalogResult {
    const snapshot = this.battleCatalogDirectory.loadSnapshot();

    const units = [...snapshot.units.values()]
      .map((unit) => projectUnit(unit, snapshot))
      .sort((a, b) => a.unitDefinitionId.localeCompare(b.unitDefinitionId));

    const memories = [...snapshot.memories.values()]
      .map((memory) => projectMemory(memory, snapshot))
      .sort((a, b) => a.memoryDefinitionId.localeCompare(b.memoryDefinitionId));

    return { catalogRevision: snapshot.catalogRevision, units, memories };
  }
}
