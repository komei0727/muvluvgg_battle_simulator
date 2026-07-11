import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCatalogSrcCommand,
  formatCatalogSourceError,
  generateCatalogCommand,
} from "./catalog-src-cli.js";
import { CatalogSourceError } from "./catalog-src-aggregator.js";

/**
 * Issue #50: thin, testable orchestration behind
 * `pnpm run generate-catalog` / `pnpm run check-catalog-src`, split from the
 * executable entry points the same way `catalog-cli.ts` backs
 * `validate-catalog-cli.ts`.
 */

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../__fixtures__/${segments.join("/")}`, import.meta.url));
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "catalog-src-cli-test-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("generateCatalogCommand", () => {
  it("CT-CAT-SRCCLI-001: writes catalog/ and reports ok=true with the six generated file names", async () => {
    const result = await generateCatalogCommand(
      fixturePath("catalog-src", "valid", "minimal"),
      outDir,
      "test-cli.1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.catalogRevision).toBe("test-cli.1");
      expect([...result.filesWritten].sort()).toEqual(
        [
          "capabilities.json",
          "effects.json",
          "manifest.json",
          "memories.json",
          "skills.json",
          "units.json",
        ].sort(),
      );
    }
  });

  it("CT-CAT-SRCCLI-002: reports ok=false with a formatted message for a malformed catalog-src", async () => {
    const result = await generateCatalogCommand(
      fixturePath("catalog-src", "invalid", "mismatched-unit"),
      outDir,
      "test-cli.1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("UNIT_WRONG_DIR");
    }
  });
});

describe("checkCatalogSrcCommand", () => {
  it("CT-CAT-SRCCLI-003: reports upToDate=true right after generateCatalogCommand", async () => {
    await generateCatalogCommand(
      fixturePath("catalog-src", "valid", "minimal"),
      outDir,
      "test-cli.1",
    );
    const result = await checkCatalogSrcCommand(
      fixturePath("catalog-src", "valid", "minimal"),
      outDir,
    );
    expect(result).toEqual({ ok: true, upToDate: true, diffFiles: [] });
  });

  it("CT-CAT-SRCCLI-004: reports upToDate=false naming the drifted files when catalog-src changed since generation", async () => {
    await generateCatalogCommand(
      fixturePath("catalog-src", "valid", "minimal"),
      outDir,
      "test-cli.1",
    );
    const result = await checkCatalogSrcCommand(
      fixturePath("catalog-src", "valid", "with-memory"),
      outDir,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upToDate).toBe(false);
      expect(result.diffFiles.length).toBeGreaterThan(0);
    }
  });

  it("CT-CAT-SRCCLI-005: reports ok=false when catalogDir has no manifest.json to read a revision from", async () => {
    const result = await checkCatalogSrcCommand(
      fixturePath("catalog-src", "valid", "minimal"),
      outDir,
    );
    expect(result.ok).toBe(false);
  });

  it("CT-CAT-SRCCLI-006: reports ok=false for a malformed catalog-src", async () => {
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify({ schemaVersion: 2, catalogRevision: "test-cli.1", files: {} }),
    );
    const result = await checkCatalogSrcCommand(
      fixturePath("catalog-src", "invalid", "mismatched-unit"),
      outDir,
    );
    expect(result.ok).toBe(false);
  });
});

describe("formatCatalogSourceError", () => {
  it("CT-CAT-SRCCLI-007: formats a CatalogSourceError using its own message", () => {
    const error = new CatalogSourceError("/some/path", "boom");
    expect(formatCatalogSourceError(error)).toBe("/some/path: boom");
  });

  it("CT-CAT-SRCCLI-008: falls back to the error message for an unrecognized Error", () => {
    expect(formatCatalogSourceError(new Error("boom"))).toBe("boom");
  });

  it("CT-CAT-SRCCLI-009: falls back to String() for a non-Error thrown value", () => {
    expect(formatCatalogSourceError("boom")).toBe("boom");
  });
});
