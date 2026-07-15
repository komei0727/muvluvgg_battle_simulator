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

function stringField(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const v = (value as Record<string, unknown>)[field];
  return typeof v === "string" ? v : undefined;
}

/**
 * Recursively collects every `effectActionDefinitionId` reference found
 * anywhere inside `node` (skill/memory resolution trees nest actions inside
 * steps, BRANCH/RANDOM_BRANCH branches, etc.). Used to verify that a unit's
 * or memory's `effects.json` holds exactly the EffectActionDefinitions that
 * directory's own skills/triggeredEffects reference — no more (an effect no
 * longer referenced by anything in this directory) and no less (an effect
 * this directory's skills reference but that actually lives under a
 * *different* unit/memory directory). Without the "no less" half, a skill
 * could silently depend on another unit's `effects.json` entry: the
 * flattened, catalog-wide result `loadCatalogFromDirectory` validates would
 * still resolve the reference and pass, quietly breaking the "reviewable by
 * unit/memory" contract Issue #50 exists for (Issue #50 review).
 */
function collectEffectActionReferences(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectEffectActionReferences(item, into);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    const id = record.effectActionDefinitionId;
    if (typeof id === "string") {
      into.add(id);
    }
    for (const value of Object.values(record)) collectEffectActionReferences(value, into);
  }
}

function declaredUnitSkillIds(unit: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const active = unit.activeSkillDefinitionIds;
  const passive = unit.passiveSkillDefinitionIds;
  if (Array.isArray(active)) {
    for (const id of active) if (typeof id === "string") ids.add(id);
  }
  if (Array.isArray(passive)) {
    for (const id of passive) if (typeof id === "string") ids.add(id);
  }
  const extra = unit.extraSkillDefinitionId;
  if (typeof extra === "string") ids.add(extra);
  return ids;
}

function verifyUnitSkillOwnership(
  unitDir: string,
  unit: Record<string, unknown>,
  skills: readonly unknown[],
): void {
  const declared = declaredUnitSkillIds(unit);
  const actualIds = skills.map((s) => stringField(s, "skillDefinitionId"));
  const actualSet = new Set(actualIds);
  const missing = [...declared].filter((id) => !actualSet.has(id));
  const unexpected = actualIds.filter((id) => id === undefined || !declared.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`missing skill(s) declared by unit.json: ${missing.join(", ")}`);
    }
    if (unexpected.length > 0) {
      parts.push(`skill(s) not declared by this unit's unit.json: ${unexpected.join(", ")}`);
    }
    throw new CatalogSourceError(join(unitDir, "skills.json"), parts.join("; "));
  }
}

function verifyEffectOwnership(
  effectsPath: string,
  referenceSource: unknown,
  effects: readonly unknown[],
  ownerDescription: string,
): void {
  const referenced = new Set<string>();
  collectEffectActionReferences(referenceSource, referenced);
  const ownIds = effects.map((e) => stringField(e, "effectActionDefinitionId"));
  const ownSet = new Set(ownIds);
  const missing = [...referenced].filter((id) => !ownSet.has(id));
  const unowned = ownIds.filter((id) => id === undefined || !referenced.has(id));
  if (missing.length > 0 || unowned.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `effect(s) referenced by ${ownerDescription} but missing from this effects.json: ${missing.join(", ")}`,
      );
    }
    if (unowned.length > 0) {
      parts.push(`effect(s) not referenced by ${ownerDescription}: ${unowned.join(", ")}`);
    }
    throw new CatalogSourceError(effectsPath, parts.join("; "));
  }
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
  verifyUnitSkillOwnership(unitDir, unit, skills);
  const effects = readJsonArrayFile(join(unitDir, "effects.json"));
  verifyEffectOwnership(
    join(unitDir, "effects.json"),
    skills,
    effects,
    "this unit's own skills.json",
  );
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
  verifyEffectOwnership(
    join(memoryDir, "effects.json"),
    memory,
    effects,
    "this memory's own memory.json",
  );
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
