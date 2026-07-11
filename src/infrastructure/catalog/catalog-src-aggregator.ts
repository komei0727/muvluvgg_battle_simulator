import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads `catalog-src/`, the human-edited authoring source split by unit and
 * memory *version* (Issue #50): `catalog-src/units/<unitDefinitionId>/` and
 * `catalog-src/memories/<memoryDefinitionId>/`, one directory per version so
 * a character with several gacha versions gets one directory each, not one
 * shared directory keyed by character. Aggregates it back into the five
 * flat arrays that `catalog/*.json` holds (`14_Catalog定義スキーマ.md`).
 * Pure aggregation only — no Shape/Domain/Semantic validation; that remains
 * `loadCatalogFromDirectory`'s job once `catalog-src-generator.ts` writes
 * the aggregated result to `catalog/`.
 */

export class CatalogSourceError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "CatalogSourceError";
    this.path = path;
  }
}

export interface CatalogSourceAggregate {
  readonly units: readonly unknown[];
  readonly skills: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly memories: readonly unknown[];
  readonly capabilities: readonly unknown[];
}

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CatalogSourceError(path, `invalid JSON (${reason})`);
  }
}

function readJsonArrayFile(path: string): unknown[] {
  const parsed = readJsonFile(path);
  if (!Array.isArray(parsed)) {
    throw new CatalogSourceError(path, "must be a JSON array");
  }
  return parsed;
}

function readJsonObjectFile(path: string): Record<string, unknown> {
  const parsed = readJsonFile(path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CatalogSourceError(path, "must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function listVersionDirectoriesSorted(parentDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function readUnitDirectory(
  unitsDir: string,
  dirName: string,
): {
  unit: unknown;
  skills: unknown[];
  effects: unknown[];
} {
  const unitDir = join(unitsDir, dirName);
  const unit = readJsonObjectFile(join(unitDir, "unit.json"));
  if (unit.unitDefinitionId !== dirName) {
    throw new CatalogSourceError(
      unitDir,
      `directory name "${dirName}" does not match unit.json's unitDefinitionId "${String(unit.unitDefinitionId)}"`,
    );
  }
  const skills = readJsonArrayFile(join(unitDir, "skills.json"));
  const effects = readJsonArrayFile(join(unitDir, "effects.json"));
  return { unit, skills, effects };
}

function readMemoryDirectory(
  memoriesDir: string,
  dirName: string,
): {
  memory: unknown;
  effects: unknown[];
} {
  const memoryDir = join(memoriesDir, dirName);
  const memory = readJsonObjectFile(join(memoryDir, "memory.json"));
  if (memory.memoryDefinitionId !== dirName) {
    throw new CatalogSourceError(
      memoryDir,
      `directory name "${dirName}" does not match memory.json's memoryDefinitionId "${String(memory.memoryDefinitionId)}"`,
    );
  }
  const effects = readJsonArrayFile(join(memoryDir, "effects.json"));
  return { memory, effects };
}

export function readCatalogSource(catalogSrcDir: string): CatalogSourceAggregate {
  const capabilities = readJsonArrayFile(join(catalogSrcDir, "capabilities.json"));

  const units: unknown[] = [];
  const skills: unknown[] = [];
  const effects: unknown[] = [];
  const unitsDir = join(catalogSrcDir, "units");
  for (const dirName of listVersionDirectoriesSorted(unitsDir)) {
    const unitSource = readUnitDirectory(unitsDir, dirName);
    units.push(unitSource.unit);
    skills.push(...unitSource.skills);
    effects.push(...unitSource.effects);
  }

  const memories: unknown[] = [];
  const memoriesDir = join(catalogSrcDir, "memories");
  for (const dirName of listVersionDirectoriesSorted(memoriesDir)) {
    const memorySource = readMemoryDirectory(memoriesDir, dirName);
    memories.push(memorySource.memory);
    effects.push(...memorySource.effects);
  }

  return { units, skills, effects, memories, capabilities };
}
