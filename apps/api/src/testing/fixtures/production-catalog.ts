import {
  createEffectActionDefinitionId,
  createMemoryDefinitionId,
  createSkillDefinitionId,
  createUnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { EffectActionDefinition } from "../../domain/catalog/definitions/effect-action-definition.js";
import type { MemoryDefinition } from "../../domain/catalog/definitions/memory-definition.js";
import type { SkillDefinition } from "../../domain/catalog/definitions/skill-definition.js";
import type { UnitDefinition } from "../../domain/catalog/definitions/unit-definition.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import { loadCatalogFromDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * 実 `catalog/` からのsnapshot取得と型付き参照。production-catalogテストが
 * 素のstring IDをbranded型へ `as never` で強制していた箇所を、正規のID
 * factory（prefix検証つき）経由へ一本化する。
 */

/** 実 `catalog/` をロードし、指定Unit/Memoryの定義グラフsnapshotを返す。 */
export function loadProductionSnapshot(
  catalogDir: string,
  unitDefinitionIds: readonly string[],
  memoryDefinitionIds: readonly string[] = [],
): BattleCatalogSnapshot {
  return loadCatalogFromDirectory(catalogDir).loadSnapshot(
    unitDefinitionIds.map((id) => createUnitDefinitionId(id)),
    memoryDefinitionIds.map((id) => createMemoryDefinitionId(id)),
  );
}

/**
 * snapshotへ含まれなかったIDは `undefined` で返る（`BattleCatalog` portの契約）
 * ため、テストが `!` や `as never` で握り潰さず、欠落を即座に失敗として報せる。
 */
function required<T>(value: T | undefined, kind: string, id: string): T {
  if (value === undefined) {
    throw new Error(`${kind} "${id}" is not present in the loaded catalog snapshot`);
  }
  return value;
}

export function unitFrom(snapshot: BattleCatalogSnapshot, id: string): UnitDefinition {
  return required(snapshot.units.get(createUnitDefinitionId(id)), "UnitDefinition", id);
}

export function skillFrom(snapshot: BattleCatalogSnapshot, id: string): SkillDefinition {
  return required(snapshot.skills.get(createSkillDefinitionId(id)), "SkillDefinition", id);
}

export function effectActionFrom(
  snapshot: BattleCatalogSnapshot,
  id: string,
): EffectActionDefinition {
  return required(
    snapshot.effectActions.get(createEffectActionDefinitionId(id)),
    "EffectActionDefinition",
    id,
  );
}

export function memoryFrom(snapshot: BattleCatalogSnapshot, id: string): MemoryDefinition {
  return required(snapshot.memories.get(createMemoryDefinitionId(id)), "MemoryDefinition", id);
}
