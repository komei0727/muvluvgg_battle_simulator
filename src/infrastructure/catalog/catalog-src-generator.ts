import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as prettier from "prettier";
import { readCatalogSource } from "./catalog-src-aggregator.js";
import {
  CATALOG_FILE_NAMES,
  CURRENT_CATALOG_SCHEMA_VERSION,
  sha256Hex,
  type CatalogFileName,
  type CatalogManifest,
} from "./catalog-manifest.js";

/**
 * Turns `catalog-src/` (Issue #50 authoring source, split by unit/memory
 * version) into the five `catalog/*.json` files plus `manifest.json`, so
 * `catalog/` stays a deterministically generated artifact rather than a
 * hand-edited one. Formatting goes through the repo's own Prettier config
 * (`.prettierrc`) so generated output passes `pnpm run format-check`
 * unchanged.
 */

export interface GenerateCatalogOptions {
  readonly catalogSrcDir: string;
  readonly catalogDir: string;
  readonly catalogRevision: string;
}

export type GeneratedCatalogFiles = Readonly<Record<CatalogFileName | "manifest.json", string>>;

async function formatJson(content: string, forPath: string): Promise<string> {
  const config = (await prettier.resolveConfig(forPath)) ?? {};
  return prettier.format(content, { ...config, filepath: forPath });
}

export async function buildCatalogFiles(
  options: GenerateCatalogOptions,
): Promise<GeneratedCatalogFiles> {
  const source = readCatalogSource(options.catalogSrcDir);
  const byFile: Record<string, readonly unknown[]> = {
    "units.json": source.units,
    "skills.json": source.skills,
    "effects.json": source.effects,
    "memories.json": source.memories,
    "capabilities.json": source.capabilities,
  };

  const files: Record<string, string> = {};
  for (const fileName of CATALOG_FILE_NAMES) {
    files[fileName] = await formatJson(
      JSON.stringify(byFile[fileName]),
      join(options.catalogDir, fileName),
    );
  }

  const manifest: CatalogManifest = {
    schemaVersion: CURRENT_CATALOG_SCHEMA_VERSION,
    catalogRevision: options.catalogRevision,
    files: {
      "units.json": sha256Hex(files["units.json"]!),
      "skills.json": sha256Hex(files["skills.json"]!),
      "effects.json": sha256Hex(files["effects.json"]!),
      "memories.json": sha256Hex(files["memories.json"]!),
      "capabilities.json": sha256Hex(files["capabilities.json"]!),
    },
  };
  files["manifest.json"] = await formatJson(
    JSON.stringify(manifest),
    join(options.catalogDir, "manifest.json"),
  );

  return files as GeneratedCatalogFiles;
}

export async function generateCatalogFiles(
  options: GenerateCatalogOptions,
): Promise<GeneratedCatalogFiles> {
  const files = await buildCatalogFiles(options);
  mkdirSync(options.catalogDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(options.catalogDir, fileName), content);
  }
  return files;
}

export interface CatalogDriftResult {
  readonly upToDate: boolean;
  readonly diffFiles: readonly string[];
}

export async function checkCatalogUpToDate(
  options: GenerateCatalogOptions,
): Promise<CatalogDriftResult> {
  const generated = await buildCatalogFiles(options);
  const diffFiles: string[] = [];
  for (const [fileName, content] of Object.entries(generated)) {
    let existing: string | undefined;
    try {
      existing = readFileSync(join(options.catalogDir, fileName), "utf8");
    } catch {
      existing = undefined;
    }
    if (existing !== content) {
      diffFiles.push(fileName);
    }
  }
  return { upToDate: diffFiles.length === 0, diffFiles };
}
