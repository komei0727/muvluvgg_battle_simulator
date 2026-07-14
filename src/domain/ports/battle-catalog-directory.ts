import type { BattleCatalogSnapshot } from "./battle-catalog.js";

/**
 * Domain Port for whole-Catalog listing (`09_アプリケーション設計.md` の
 * `BattleCatalogDirectory`). Returns every Unit/Memory plus the Skill/
 * EffectAction/Capability closure needed to compute `selectable`, separate
 * from `BattleCatalog.loadSnapshot`'s requested-ID closure — an adapter may
 * implement both ports from the same validated, immutable Catalog index.
 */
export interface BattleCatalogDirectory {
  loadSnapshot(): BattleCatalogSnapshot;
}
