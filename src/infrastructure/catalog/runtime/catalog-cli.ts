import { CatalogIntegrityError } from "../../../domain/catalog/catalog-integrity.js";
import { CatalogShapeValidationError } from "./catalog-definition-mapper.js";
import { CatalogFileContentError, loadCatalogFromDirectory } from "./catalog-file-loader.js";
import {
  CatalogFileHashMismatchError,
  CatalogManifestValidationError,
  UnsupportedCatalogSchemaVersionError,
} from "./catalog-manifest.js";

/**
 * Formatting and validation logic behind `pnpm run validate-catalog`
 * (issue #7 の「Catalog検証CLIまたはscript」). Kept separate from the
 * executable entry point (`validate-catalog-cli.ts`) so the error-formatting
 * contract is unit-testable without touching `process.argv`/`process.exit`.
 */

export function formatCatalogValidationError(error: unknown): string {
  if (error instanceof CatalogIntegrityError) {
    return [
      `Catalog integrity validation failed with ${error.violations.length} violation(s):`,
      ...error.violations.map((v) => `  [${v.rule}] ${v.targetId}: ${v.message}`),
    ].join("\n");
  }
  if (error instanceof CatalogFileHashMismatchError) {
    return [
      "Catalog file hash verification failed:",
      ...error.mismatches.map((m) => `  ${m.file}: expected ${m.expected}, got ${m.actual}`),
    ].join("\n");
  }
  if (error instanceof CatalogManifestValidationError) {
    return [
      "manifest.json failed shape validation:",
      ...error.errors.map((e) => `  ${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`),
    ].join("\n");
  }
  if (error instanceof UnsupportedCatalogSchemaVersionError) {
    return error.message;
  }
  if (error instanceof CatalogShapeValidationError) {
    return [
      `${error.artifact} failed shape validation:`,
      ...error.errors.map((e) => `  ${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`),
    ].join("\n");
  }
  if (error instanceof CatalogFileContentError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export type CatalogValidationResult =
  | { readonly ok: true; readonly catalogRevision: string }
  | { readonly ok: false; readonly message: string };

export function validateCatalogDirectory(catalogDir: string): CatalogValidationResult {
  try {
    const catalog = loadCatalogFromDirectory(catalogDir);
    return { ok: true, catalogRevision: catalog.catalogRevision };
  } catch (error) {
    return { ok: false, message: formatCatalogValidationError(error) };
  }
}
