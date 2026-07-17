import type { CapabilityDefinition } from "../catalog/capability/capability-definition.js";
import type {
  CapabilityId,
  EffectActionDefinitionId,
  MemoryDefinitionId,
  SkillDefinitionId,
  UnitDefinitionId,
} from "../catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../catalog/definitions/effect-action-definition.js";
import type { MemoryDefinition } from "../catalog/definitions/memory-definition.js";
import type { SkillDefinition } from "../catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../catalog/definitions/unit-definition.js";

/**
 * Requested Units/Memories plus their transitive Skill/EffectAction/Capability
 * closure (`09_アプリケーション設計.md` の定義グラフ). Requested IDs absent
 * from the underlying Catalog are simply missing from `units`/`memories` —
 * callers detect gaps with `.has(id)` rather than the port throwing, so a
 * caller can report every unknown ID rather than just the first.
 */
export interface BattleCatalogSnapshot {
  readonly catalogRevision: string;
  readonly units: ReadonlyMap<UnitDefinitionId, UnitDefinition>;
  readonly skills: ReadonlyMap<SkillDefinitionId, SkillDefinition>;
  readonly effectActions: ReadonlyMap<EffectActionDefinitionId, EffectActionDefinition>;
  readonly memories: ReadonlyMap<MemoryDefinitionId, MemoryDefinition>;
  readonly capabilities: ReadonlyMap<CapabilityId, CapabilityDefinition>;
}

/**
 * Domain Port for Catalog access (`09_アプリケーション設計.md` の
 * `BattleCatalog`). A whole Battle only ever calls `loadSnapshot` once; the
 * adapter is expected to hold an already-validated, immutable Catalog in
 * memory so this never re-reads files per request (`11_インフラストラクチャ
 * 設計.md` 「リクエストごとのファイル再読み込みを不要にする」).
 */
export interface BattleCatalog {
  loadSnapshot(
    unitDefinitionIds: readonly UnitDefinitionId[],
    memoryDefinitionIds: readonly MemoryDefinitionId[],
  ): BattleCatalogSnapshot;
}
