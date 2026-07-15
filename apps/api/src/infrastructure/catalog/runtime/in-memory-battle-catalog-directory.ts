import type { CatalogIndex } from "../../../domain/catalog/catalog-integrity.js";
import type { BattleCatalogDirectory } from "../../../domain/ports/battle-catalog-directory.js";
import type { BattleCatalogSnapshot } from "../../../domain/ports/battle-catalog.js";

/**
 * `BattleCatalogDirectory` Port adapter (`09_アプリケーション設計.md`,
 * `11_インフラストラクチャ設計.md` の BattleSimulationCatalog Read Model).
 * Wraps the same already-validated `CatalogIndex` `InMemoryBattleCatalog`
 * uses, but returns the whole index every call instead of a requested-ID
 * closure — `buildCatalogIndex` already exposes its Maps as immutable
 * `ReadonlyMap`s (`readonly-map.ts`), so `loadSnapshot` never re-reads the
 * Catalog source or copies the index per call.
 */
export class InMemoryBattleCatalogDirectory implements BattleCatalogDirectory {
  private readonly catalogRevision: string;
  private readonly index: CatalogIndex;

  constructor(catalogRevision: string, index: CatalogIndex) {
    this.catalogRevision = catalogRevision;
    this.index = index;
  }

  loadSnapshot(): BattleCatalogSnapshot {
    return {
      catalogRevision: this.catalogRevision,
      units: this.index.units,
      skills: this.index.skills,
      effectActions: this.index.effectActions,
      memories: this.index.memories,
      capabilities: this.index.capabilities,
    };
  }
}
