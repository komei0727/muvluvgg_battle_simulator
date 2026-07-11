import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCatalogFiles,
  checkCatalogUpToDate,
  generateCatalogFiles,
} from "./catalog-src-generator.js";
import { sha256Hex } from "./catalog-manifest.js";
import { loadCatalogFromDirectory } from "./catalog-file-loader.js";

/**
 * Issue #50: `catalog-src-generator.ts` turns the aggregated
 * `catalog-src/` content (`catalog-src-aggregator.ts`) into the five
 * `catalog/*.json` files plus `manifest.json`, deterministically, so
 * `catalog/` stays a generated artifact rather than a hand-edited one.
 */

function fixturePath(...segments: string[]): string {
  return fileURLToPath(new URL(`./__fixtures__/${segments.join("/")}`, import.meta.url));
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "catalog-src-generator-test-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("buildCatalogFiles", () => {
  it("IT-CAT-GEN-001: produces parseable JSON content for all five catalog files plus manifest.json", async () => {
    const files = await buildCatalogFiles({
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    });
    expect(() => {
      JSON.parse(files["units.json"]);
    }).not.toThrow();
    expect(() => {
      JSON.parse(files["skills.json"]);
    }).not.toThrow();
    expect(() => {
      JSON.parse(files["effects.json"]);
    }).not.toThrow();
    expect(() => {
      JSON.parse(files["memories.json"]);
    }).not.toThrow();
    expect(() => {
      JSON.parse(files["capabilities.json"]);
    }).not.toThrow();
    expect(() => {
      JSON.parse(files["manifest.json"]);
    }).not.toThrow();
  });

  it("IT-CAT-GEN-002: manifest.json's file hashes match sha256Hex of the generated content", async () => {
    const files = await buildCatalogFiles({
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    });
    const manifest = JSON.parse(files["manifest.json"]) as { files: Record<string, string> };
    expect(manifest.files["units.json"]).toBe(sha256Hex(files["units.json"]));
    expect(manifest.files["skills.json"]).toBe(sha256Hex(files["skills.json"]));
    expect(manifest.files["effects.json"]).toBe(sha256Hex(files["effects.json"]));
    expect(manifest.files["memories.json"]).toBe(sha256Hex(files["memories.json"]));
    expect(manifest.files["capabilities.json"]).toBe(sha256Hex(files["capabilities.json"]));
  });

  it("IT-CAT-GEN-003: manifest.json carries the given catalogRevision and schemaVersion 2", async () => {
    const files = await buildCatalogFiles({
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.7",
    });
    const manifest = JSON.parse(files["manifest.json"]) as {
      schemaVersion: number;
      catalogRevision: string;
    };
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.catalogRevision).toBe("test-gen.7");
  });

  it("IT-CAT-GEN-004: is idempotent — regenerating from the same inputs yields byte-identical output", async () => {
    const options = {
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    };
    const first = await buildCatalogFiles(options);
    const second = await buildCatalogFiles(options);
    expect(second).toEqual(first);
  });
});

describe("generateCatalogFiles", () => {
  it("IT-CAT-GEN-005: writes all six files to catalogDir, loadable by loadCatalogFromDirectory", async () => {
    await generateCatalogFiles({
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    });
    const catalog = loadCatalogFromDirectory(outDir);
    expect(catalog.catalogRevision).toBe("test-gen.1");
  });

  it("IT-CAT-GEN-006: writes catalog/*.json formatted per the repo's Prettier config", async () => {
    await generateCatalogFiles({
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    });
    const written = readFileSync(join(outDir, "units.json"), "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(written.startsWith("[\n")).toBe(true);
  });
});

describe("checkCatalogUpToDate", () => {
  it("IT-CAT-GEN-007: reports drift when catalogDir has no generated files yet", async () => {
    const result = await checkCatalogUpToDate({
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    });
    expect(result.upToDate).toBe(false);
    expect(result.diffFiles).toContain("units.json");
  });

  it("IT-CAT-GEN-008: reports up to date immediately after generateCatalogFiles with the same revision", async () => {
    const options = {
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    };
    await generateCatalogFiles(options);
    const result = await checkCatalogUpToDate(options);
    expect(result).toEqual({ upToDate: true, diffFiles: [] });
  });

  it("IT-CAT-GEN-009: reports drift when catalog-src/ changed after the last generateCatalogFiles run", async () => {
    const options = {
      catalogSrcDir: fixturePath("catalog-src-minimal"),
      catalogDir: outDir,
      catalogRevision: "test-gen.1",
    };
    await generateCatalogFiles(options);
    const result = await checkCatalogUpToDate({
      ...options,
      catalogSrcDir: fixturePath("catalog-src-with-memory"),
    });
    expect(result.upToDate).toBe(false);
  });
});
