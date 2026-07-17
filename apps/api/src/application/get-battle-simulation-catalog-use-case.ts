import {
  collectRequiredCapabilities,
  findUnimplementedCapabilities,
} from "../domain/catalog/capability/capability-availability.js";
import type {
  Attribute,
  PositionRow,
  Role,
  UnitType,
} from "../domain/catalog/definitions/catalog-enums.js";
import type {
  CapabilityId,
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../domain/catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../domain/catalog/definitions/memory-definition.js";
import type { UnitDefinition } from "../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalogDirectory } from "../domain/ports/battle-catalog-directory.js";
import type { BattleCatalogSnapshot } from "../domain/ports/battle-catalog.js";
import { deepFreeze } from "../domain/shared/deep-freeze.js";

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

function buildResult(snapshot: BattleCatalogSnapshot): BattleSimulationCatalogResult {
  const units = [...snapshot.units.values()]
    .map((unit) => projectUnit(unit, snapshot))
    .sort((a, b) => a.unitDefinitionId.localeCompare(b.unitDefinitionId));

  const memories = [...snapshot.memories.values()]
    .map((memory) => projectMemory(memory, snapshot))
    .sort((a, b) => a.memoryDefinitionId.localeCompare(b.memoryDefinitionId));

  return deepFreeze({ catalogRevision: snapshot.catalogRevision, units, memories });
}

/**
 * `09_アプリケーション設計.md` の `GetBattleSimulationCatalogUseCase`:
 * `BattleCatalogDirectory`から取得した検証済みスナップショットを、
 * `SimulationPreflightValidator`と同じ `collectRequiredCapabilities`/
 * `findUnimplementedCapabilities` で選択可否projectionする。Skill、
 * EffectAction、Formula、Condition、triggeredEffectsの完全定義は
 * Resultへ公開しない。
 *
 * `11_インフラストラクチャ設計.md`「Catalog一覧read modelを起動時に1回だけ
 * 構築する」: `loadSnapshot`とprojectionはコンストラクタで1回だけ実行し、
 * `execute()`は同じResultをそのまま返す — HTTPリクエストのたびに
 * Capability収集・sortをやり直さない。全呼び出しが同じResultインスタンスを
 * 共有するため、`deepFreeze`でResultグラフ全体（`units`/`memories`配列、
 * 各summary、`unavailableCapabilities`配列）を実行時にも不変化し、
 * 一呼び出し側の変更が以後の`execute()`結果へ漏れ出さないようにする。
 */
export class GetBattleSimulationCatalogUseCase {
  private readonly result: BattleSimulationCatalogResult;

  constructor(dependencies: GetBattleSimulationCatalogUseCaseDependencies) {
    const snapshot = dependencies.battleCatalogDirectory.loadSnapshot();
    this.result = buildResult(snapshot);
  }

  execute(): BattleSimulationCatalogResult {
    return this.result;
  }
}
