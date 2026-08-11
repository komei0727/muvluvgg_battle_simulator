import type {
  Attribute,
  PositionRow,
  Role,
  UnitType,
} from "../../domain/catalog/definitions/catalog-enums.js";
import type {
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { MemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import {
  buildGearEffects,
  gearEffectsFingerprint,
  type BattleSimulationGearEffect,
} from "./gear-effect-catalog.js";
import type { BattleCatalogDirectory } from "../../domain/ports/battle-catalog-directory.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { deepFreeze } from "../../domain/shared/deep-freeze.js";

export interface BattleSimulationUnitSummary {
  readonly unitDefinitionId: UnitDefinitionId;
  readonly displayName: string;
  readonly characterName: string;
  readonly attribute: Attribute;
  readonly unitType: UnitType;
  readonly role: Role;
  readonly positionAptitudes: readonly PositionRow[];
}

export interface BattleSimulationMemorySummary {
  readonly memoryDefinitionId: MemoryDefinitionId;
  readonly displayName: string;
}

export interface BattleSimulationCatalogResult {
  readonly catalogRevision: string;
  readonly units: readonly BattleSimulationUnitSummary[];
  readonly memories: readonly BattleSimulationMemorySummary[];
  /** R-ENH-04 #3のギア効果表。クライアントが表を持たずに上昇値を表示するために公開する。 */
  readonly gearEffects: readonly BattleSimulationGearEffect[];
  /**
   * このread model全体の版。ETagの導出元であり、Catalogファイル由来の
   * `catalogRevision`とコード定数由来の効果表fingerprintの両方を含む
   * （`10_API設計.md`「ETag」。効果表だけを変えたデプロイでもETagが変わる）。
   */
  readonly representationRevision: string;
}

export interface GetBattleSimulationCatalogUseCaseDependencies {
  readonly battleCatalogDirectory: BattleCatalogDirectory;
}

function projectUnit(unit: UnitDefinition): BattleSimulationUnitSummary {
  return {
    unitDefinitionId: unit.unitDefinitionId,
    displayName: unit.metadata.displayName,
    characterName: unit.metadata.characterName,
    attribute: unit.attribute,
    unitType: unit.unitType,
    role: unit.role,
    positionAptitudes: unit.positionAptitudes,
  };
}

function projectMemory(memory: MemoryDefinition): BattleSimulationMemorySummary {
  return {
    memoryDefinitionId: memory.memoryDefinitionId,
    displayName: memory.metadata.displayName,
  };
}

function buildResult(snapshot: BattleCatalogSnapshot): BattleSimulationCatalogResult {
  const units = [...snapshot.units.values()]
    .map(projectUnit)
    .sort((a, b) => a.unitDefinitionId.localeCompare(b.unitDefinitionId));

  const memories = [...snapshot.memories.values()]
    .map(projectMemory)
    .sort((a, b) => a.memoryDefinitionId.localeCompare(b.memoryDefinitionId));

  const gearEffects = buildGearEffects();

  return deepFreeze({
    catalogRevision: snapshot.catalogRevision,
    units,
    memories,
    gearEffects,
    representationRevision: `${snapshot.catalogRevision}+gear.${gearEffectsFingerprint(gearEffects)}`,
  });
}

/**
 * `09_アプリケーション設計.md` の `GetBattleSimulationCatalogUseCase`:
 * `BattleCatalogDirectory`から取得した検証済みスナップショットを表示用へ
 * projectionする。Skill、EffectAction、Formula、Condition、triggeredEffects
 * の完全定義はResultへ公開しない。
 *
 * `11_インフラストラクチャ設計.md`「Catalog一覧read modelを起動時に1回だけ
 * 構築する」: `loadSnapshot`とprojectionはコンストラクタで1回だけ実行し、
 * `execute()`は同じResultをそのまま返す。全呼び出しが同じResultインスタンスを
 * 共有するため、`deepFreeze`でResultグラフ全体（`units`/`memories`配列と
 * 各summary）を実行時にも不変化し、一呼び出し側の変更が以後の`execute()`
 * 結果へ漏れ出さないようにする。
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
