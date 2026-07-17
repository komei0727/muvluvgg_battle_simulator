import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCatalogIndex,
  type CatalogDefinitions,
} from "../../../domain/catalog/integrity/catalog-integrity.js";
import {
  mapCapabilityDefinition,
  mapEffectActionDefinition,
  mapMemoryDefinition,
  mapSkillDefinition,
  mapUnitDefinition,
} from "./catalog-definition-mapper.js";
import {
  CATALOG_FILE_NAMES,
  parseCatalogManifest,
  verifyCatalogFileHashes,
  type CatalogFileName,
} from "./catalog-manifest.js";
import { InMemoryBattleCatalog } from "./in-memory-battle-catalog.js";
import { InMemoryBattleCatalogDirectory } from "./in-memory-battle-catalog-directory.js";

/**
 * Read → Hash → Shape → Resolve → Semantic → Freeze
 * (`11_インフラストラクチャ設計.md` の読み込み段階) for a Catalog directory
 * laid out as `14_Catalog定義スキーマ.md` describes: `manifest.json` plus the
 * five per-kind arrays. Intended to run once at process/Worker startup
 * (`InMemoryBattleCatalog` never re-reads the filesystem afterward).
 */

export class CatalogFileContentError extends Error {
  readonly file: string;

  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "CatalogFileContentError";
    this.file = file;
  }
}

function readCatalogJsonArray(catalogDir: string, fileName: CatalogFileName): readonly unknown[] {
  const raw = readFileSync(join(catalogDir, fileName), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CatalogFileContentError(fileName, `invalid JSON (${reason})`);
  }
  if (!Array.isArray(parsed)) {
    throw new CatalogFileContentError(fileName, "must be a JSON array");
  }
  return parsed;
}

function readCatalogIndex(catalogDir: string): {
  readonly catalogRevision: string;
  readonly index: ReturnType<typeof buildCatalogIndex>;
} {
  const manifestRaw = readFileSync(join(catalogDir, "manifest.json"), "utf8");
  const manifest = parseCatalogManifest(JSON.parse(manifestRaw));

  const fileContents: Record<CatalogFileName, string> = {
    "units.json": "",
    "skills.json": "",
    "effects.json": "",
    "memories.json": "",
    "capabilities.json": "",
  };
  for (const fileName of CATALOG_FILE_NAMES) {
    fileContents[fileName] = readFileSync(join(catalogDir, fileName), "utf8");
  }
  verifyCatalogFileHashes(manifest, fileContents);

  const definitions: CatalogDefinitions = {
    units: readCatalogJsonArray(catalogDir, "units.json").map(mapUnitDefinition),
    skills: readCatalogJsonArray(catalogDir, "skills.json").map(mapSkillDefinition),
    effectActions: readCatalogJsonArray(catalogDir, "effects.json").map(mapEffectActionDefinition),
    memories: readCatalogJsonArray(catalogDir, "memories.json").map(mapMemoryDefinition),
    capabilities: readCatalogJsonArray(catalogDir, "capabilities.json").map(
      mapCapabilityDefinition,
    ),
  };

  return { catalogRevision: manifest.catalogRevision, index: buildCatalogIndex(definitions) };
}

export function loadCatalogFromDirectory(catalogDir: string): InMemoryBattleCatalog {
  const { catalogRevision, index } = readCatalogIndex(catalogDir);
  return new InMemoryBattleCatalog(catalogRevision, index);
}

/**
 * `09_アプリケーション設計.md`/`11_インフラストラクチャ設計.md`の
 * `BattleCatalogDirectory`: `#91`のGET一覧APIはHTTPメインスレッドで一覧
 * read modelを構築するため、Workerと同じRead → Hash → Shape → Resolve →
 * Semanticパイプラインを共有しつつ、`loadCatalogFromDirectory`とは別の
 * adapter（推移的closureではなく全件を返す）へ包む。
 */
export function loadBattleCatalogDirectory(catalogDir: string): InMemoryBattleCatalogDirectory {
  const { catalogRevision, index } = readCatalogIndex(catalogDir);
  return new InMemoryBattleCatalogDirectory(catalogRevision, index);
}
