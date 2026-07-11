import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CatalogSourceError } from "./catalog-src-aggregator.js";
import {
  checkCatalogUpToDate,
  generateCatalogFiles,
  type CatalogDriftResult,
} from "./catalog-src-generator.js";

/**
 * Formatting and orchestration behind `pnpm run generate-catalog` and
 * `pnpm run check-catalog-src` (Issue #50). Kept separate from the
 * executable entry points so the contract is unit-testable without
 * touching `process.argv`/`process.exit`, mirroring `catalog-cli.ts`.
 */

export function formatCatalogSourceError(error: unknown): string {
  if (error instanceof CatalogSourceError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export type GenerateCatalogResult =
  | {
      readonly ok: true;
      readonly catalogRevision: string;
      readonly filesWritten: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

export async function generateCatalogCommand(
  catalogSrcDir: string,
  catalogDir: string,
  catalogRevision: string,
): Promise<GenerateCatalogResult> {
  try {
    const files = await generateCatalogFiles({ catalogSrcDir, catalogDir, catalogRevision });
    return { ok: true, catalogRevision, filesWritten: Object.keys(files) };
  } catch (error) {
    return { ok: false, message: formatCatalogSourceError(error) };
  }
}

export type CheckCatalogSrcResult =
  | ({ readonly ok: true } & CatalogDriftResult)
  | { readonly ok: false; readonly message: string };

function readExistingCatalogRevision(catalogDir: string): string {
  const manifestPath = join(catalogDir, "manifest.json");
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${manifestPath} to determine catalogRevision (${reason})`, {
      cause: error,
    });
  }
  const manifest = JSON.parse(manifestRaw) as { catalogRevision?: unknown };
  if (typeof manifest.catalogRevision !== "string") {
    throw new Error(`${manifestPath}: missing or invalid catalogRevision`);
  }
  return manifest.catalogRevision;
}

export async function checkCatalogSrcCommand(
  catalogSrcDir: string,
  catalogDir: string,
): Promise<CheckCatalogSrcResult> {
  try {
    const catalogRevision = readExistingCatalogRevision(catalogDir);
    const result = await checkCatalogUpToDate({ catalogSrcDir, catalogDir, catalogRevision });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: formatCatalogSourceError(error) };
  }
}
