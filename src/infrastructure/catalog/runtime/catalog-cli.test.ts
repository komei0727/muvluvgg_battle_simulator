import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatCatalogValidationError, validateCatalogDirectory } from "./catalog-cli.js";

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../__fixtures__/${segments.join("/")}`, import.meta.url));
}

describe("validateCatalogDirectory", () => {
  it("CT-CAT-CLI-001: reports ok=true with the catalogRevision for a valid Catalog", () => {
    const result = validateCatalogDirectory(fixturePath("runtime", "valid", "minimal"));
    expect(result).toEqual({ ok: true, catalogRevision: "test-minimal.1" });
  });

  it("CT-CAT-CLI-002: reports ok=false with a formatted message for an invalid Catalog", () => {
    const result = validateCatalogDirectory(fixturePath("runtime", "invalid", "duplicate-id"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("DUPLICATE_ID");
      expect(result.message).toContain("UNIT_001");
    }
  });
});

describe("formatCatalogValidationError", () => {
  it("CT-CAT-CLI-003: formats every integrity violation, not just the first", () => {
    const result = validateCatalogDirectory(fixturePath("runtime", "invalid", "duplicate-id"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const lines = result.message.split("\n");
      expect(lines.some((l) => l.includes("[DUPLICATE_ID]"))).toBe(true);
    }
  });

  it("CT-CAT-CLI-004: formats a hash mismatch naming the offending file", () => {
    const result = validateCatalogDirectory(fixturePath("runtime", "invalid", "hash-mismatch"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("units.json");
    }
  });

  it("CT-CAT-CLI-005: formats an unknown schemaVersion error", () => {
    const result = validateCatalogDirectory(
      fixturePath("runtime", "invalid", "unknown-schema-version"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("schemaVersion");
    }
  });

  it("CT-CAT-CLI-006: falls back to the error message for an unrecognized error type", () => {
    expect(formatCatalogValidationError(new Error("boom"))).toBe("boom");
  });

  it("CT-CAT-CLI-007: falls back to String() for a non-Error thrown value", () => {
    expect(formatCatalogValidationError("boom")).toBe("boom");
  });
});
