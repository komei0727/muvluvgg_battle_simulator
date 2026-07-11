import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogSource } from "./catalog-src-aggregator.js";
import { checkCatalogUpToDate } from "./catalog-src-generator.js";
import { loadCatalogFromDirectory } from "../runtime/catalog-file-loader.js";

/**
 * Issue #50: `catalog/` (repo root) must always equal what regenerating
 * from `catalog-src/` (repo root) produces — `catalog/` is a generated
 * artifact, `catalog-src/` is the human-edited authoring source, split by
 * unit/memory *version* rather than by character. This test is the
 * standing guard against either drifting from the other (hand-editing
 * `catalog/` directly, or editing `catalog-src/` without regenerating).
 */

function repoRootPath(...segments: string[]): string {
  return fileURLToPath(new URL(`../../../../${segments.join("/")}`, import.meta.url));
}

function catalogRevision(): string {
  const manifest = JSON.parse(readFileSync(repoRootPath("catalog", "manifest.json"), "utf8")) as {
    catalogRevision: string;
  };
  return manifest.catalogRevision;
}

describe("catalog-src/ -> catalog/ (Issue #50 production migration)", () => {
  it("IT-CAT-SRCPROD-001: catalog/ is exactly what regenerating from catalog-src/ produces (no drift)", async () => {
    const result = await checkCatalogUpToDate({
      catalogSrcDir: repoRootPath("catalog-src"),
      catalogDir: repoRootPath("catalog"),
      catalogRevision: catalogRevision(),
    });
    expect(result).toEqual({ upToDate: true, diffFiles: [] });
  });

  it("IT-CAT-SRCPROD-002: catalog-src/ has one unit directory per unit *version*, not per character (issue #50 note)", () => {
    const source = readCatalogSource(repoRootPath("catalog-src"));
    const unitIds = source.units.map((u) => (u as { unitDefinitionId: string }).unitDefinitionId);
    expect(unitIds.length).toBe(new Set(unitIds).size);
    expect(unitIds.sort()).toEqual(
      [
        "UNIT_EVIE",
        "UNIT_FLUTE",
        "UNIT_HARRIET",
        "UNIT_KARINA",
        "UNIT_KATE",
        "UNIT_KOTOHA",
        "UNIT_LAURA",
        "UNIT_LYDIA",
        "UNIT_MIKOTO",
        "UNIT_STELLA",
      ].sort(),
    );
  });

  it("IT-CAT-SRCPROD-003: catalog/ regenerated from catalog-src/ still loads without an integrity violation", () => {
    const catalog = loadCatalogFromDirectory(join(repoRootPath("catalog")));
    expect(catalog.catalogRevision).toBe(catalogRevision());
  });
});
