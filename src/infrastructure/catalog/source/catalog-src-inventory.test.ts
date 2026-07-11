import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogSource } from "./catalog-src-aggregator.js";

/**
 * Issue #47: guards the `raw/units/` and `raw/memories/` inventory tallied in
 * `docs/ddd/15_Unit_Memory変換台帳.md` against silent drift — adding or
 * removing a raw source file without updating the ledger, or converting a
 * unit/memory into `catalog-src/` without updating its ledger row, should
 * fail this test rather than go unnoticed.
 */

function repoRootPath(...segments: string[]): string {
  return fileURLToPath(new URL(`../../../../${segments.join("/")}`, import.meta.url));
}

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name);
}

describe("raw/units, raw/memories inventory (Issue #47 ledger)", () => {
  it("IT-CAT-INV-001: raw/units/ has the 69 files tallied in the ledger", () => {
    const files = listMarkdownFiles(repoRootPath("raw", "units"));
    expect(files.length).toBe(69);
  });

  it("IT-CAT-INV-002: raw/memories/ has the 32 files tallied in the ledger", () => {
    const files = listMarkdownFiles(repoRootPath("raw", "memories"));
    expect(files.length).toBe(32);
  });

  it("IT-CAT-INV-003: catalog-src/ has exactly the 22 converted units tallied in the ledger (10 representative + 12 from Issue #47)", () => {
    const source = readCatalogSource(repoRootPath("catalog-src"));
    expect(source.units.length).toBe(22);
  });

  it("IT-CAT-INV-004: catalog-src/ has exactly the 6 converted memories tallied in the ledger (Issue #47 batch)", () => {
    const source = readCatalogSource(repoRootPath("catalog-src"));
    expect(source.memories.length).toBe(6);
  });
});
