import { createHash } from "node:crypto";
import { Ajv, type ErrorObject } from "ajv";

/**
 * `manifest.json` shape and hash verification — the "Read → Hash" stage of
 * the Catalog load pipeline (`11_インフラストラクチャ設計.md`). `schemaVersion`
 * is fixed at `2` for Catalog v2 (`14_Catalog定義スキーマ.md`).
 */

export const CATALOG_FILE_NAMES = [
  "units.json",
  "skills.json",
  "effects.json",
  "memories.json",
  "capabilities.json",
] as const;
export type CatalogFileName = (typeof CATALOG_FILE_NAMES)[number];

export const CURRENT_CATALOG_SCHEMA_VERSION = 2;

export interface CatalogManifest {
  readonly schemaVersion: number;
  readonly catalogRevision: string;
  readonly files: Readonly<Record<CatalogFileName, string>>;
}

const manifestSchema = {
  $id: "https://muvluvgg.local/catalog/manifest.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "catalogRevision", "files"],
  properties: {
    schemaVersion: { type: "integer" },
    catalogRevision: { type: "string", minLength: 1 },
    files: {
      type: "object",
      additionalProperties: false,
      required: [...CATALOG_FILE_NAMES],
      properties: Object.fromEntries(
        CATALOG_FILE_NAMES.map((name) => [
          name,
          { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        ]),
      ),
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateManifestDto = ajv.compile(manifestSchema);

export class CatalogManifestValidationError extends Error {
  readonly errors: readonly ErrorObject[];

  constructor(errors: readonly ErrorObject[]) {
    super(`manifest.json: failed JSON Schema shape validation (${errors.length} error(s))`);
    this.name = "CatalogManifestValidationError";
    this.errors = errors;
  }
}

export class UnsupportedCatalogSchemaVersionError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(
      `unsupported Catalog schemaVersion ${schemaVersion}; expected ${CURRENT_CATALOG_SCHEMA_VERSION}`,
    );
    this.name = "UnsupportedCatalogSchemaVersionError";
    this.schemaVersion = schemaVersion;
  }
}

export function parseCatalogManifest(dto: unknown): CatalogManifest {
  if (!validateManifestDto(dto)) {
    throw new CatalogManifestValidationError(validateManifestDto.errors ?? []);
  }
  const manifest = dto as CatalogManifest;
  if (manifest.schemaVersion !== CURRENT_CATALOG_SCHEMA_VERSION) {
    throw new UnsupportedCatalogSchemaVersionError(manifest.schemaVersion);
  }
  return manifest;
}

export function sha256Hex(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export interface CatalogFileHashMismatch {
  readonly file: CatalogFileName;
  readonly expected: string;
  readonly actual: string;
}

export class CatalogFileHashMismatchError extends Error {
  readonly mismatches: readonly CatalogFileHashMismatch[];

  constructor(mismatches: readonly CatalogFileHashMismatch[]) {
    super(
      `Catalog file hash mismatch: ` +
        mismatches.map((m) => `${m.file} expected ${m.expected}, got ${m.actual}`).join("; "),
    );
    this.name = "CatalogFileHashMismatchError";
    this.mismatches = mismatches;
  }
}

export function verifyCatalogFileHashes(
  manifest: CatalogManifest,
  fileContents: Readonly<Record<CatalogFileName, string>>,
): void {
  const mismatches: CatalogFileHashMismatch[] = [];
  for (const file of CATALOG_FILE_NAMES) {
    const expected = manifest.files[file];
    const actual = sha256Hex(fileContents[file]);
    if (expected !== actual) {
      mismatches.push({ file, expected, actual });
    }
  }
  if (mismatches.length > 0) {
    throw new CatalogFileHashMismatchError(mismatches);
  }
}
