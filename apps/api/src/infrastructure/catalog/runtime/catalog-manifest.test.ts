import { describe, expect, it } from "vitest";
import {
  CatalogFileHashMismatchError,
  CatalogManifestValidationError,
  parseCatalogManifest,
  sha256Hex,
  UnsupportedCatalogSchemaVersionError,
  verifyCatalogFileHashes,
} from "./catalog-manifest.js";

function validManifestDto() {
  return {
    schemaVersion: 2,
    catalogRevision: "2026-07-11.1",
    files: {
      "units.json": sha256Hex("units"),
      "skills.json": sha256Hex("skills"),
      "effects.json": sha256Hex("effects"),
      "memories.json": sha256Hex("memories"),
      "capabilities.json": sha256Hex("capabilities"),
    },
  };
}

describe("sha256Hex", () => {
  it("UT-CAT-MANIFEST-001: hashes the empty string to the well-known SHA-256 digest", () => {
    expect(sha256Hex("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("UT-CAT-MANIFEST-002: hashes a known string to its well-known SHA-256 digest", () => {
    expect(sha256Hex("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("parseCatalogManifest", () => {
  it("UT-CAT-MANIFEST-003: parses a valid schemaVersion=2 manifest", () => {
    const manifest = parseCatalogManifest(validManifestDto());
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.catalogRevision).toBe("2026-07-11.1");
  });

  it("UT-CAT-MANIFEST-004: rejects a manifest missing a required file hash", () => {
    const dto = validManifestDto();
    const files = { ...dto.files } as Partial<typeof dto.files>;
    delete files["capabilities.json"];
    expect(() => parseCatalogManifest({ ...dto, files })).toThrow(CatalogManifestValidationError);
  });

  it("UT-CAT-MANIFEST-005: rejects a manifest with an unknown top-level property", () => {
    const dto = { ...validManifestDto(), unexpected: true };
    expect(() => parseCatalogManifest(dto)).toThrow(CatalogManifestValidationError);
  });

  it("UT-CAT-MANIFEST-006: rejects a file hash not shaped as sha256:<hex>", () => {
    const dto = validManifestDto();
    const files = { ...dto.files, "units.json": "not-a-hash" };
    expect(() => parseCatalogManifest({ ...dto, files })).toThrow(CatalogManifestValidationError);
  });

  it("UT-CAT-MANIFEST-007: rejects an unknown schemaVersion", () => {
    const dto = { ...validManifestDto(), schemaVersion: 1 };
    expect(() => parseCatalogManifest(dto)).toThrow(UnsupportedCatalogSchemaVersionError);
  });
});

describe("verifyCatalogFileHashes", () => {
  it("UT-CAT-MANIFEST-008: passes when every file content matches its manifest hash", () => {
    const manifest = parseCatalogManifest(validManifestDto());
    expect(() =>
      verifyCatalogFileHashes(manifest, {
        "units.json": "units",
        "skills.json": "skills",
        "effects.json": "effects",
        "memories.json": "memories",
        "capabilities.json": "capabilities",
      }),
    ).not.toThrow();
  });

  it("UT-CAT-MANIFEST-009: reports every mismatched file, not just the first", () => {
    const manifest = parseCatalogManifest(validManifestDto());
    try {
      verifyCatalogFileHashes(manifest, {
        "units.json": "tampered",
        "skills.json": "skills",
        "effects.json": "tampered-too",
        "memories.json": "memories",
        "capabilities.json": "capabilities",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogFileHashMismatchError);
      const err = error as CatalogFileHashMismatchError;
      expect(err.mismatches.map((m) => m.file)).toEqual(["units.json", "effects.json"]);
    }
  });
});
