import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogSource } from "./catalog-src-aggregator.js";

/**
 * Issue #47: guards the `catalog-src/` conversion counts tallied in
 * `docs/ddd/15_Unit_Memory変換台帳.md` against silent drift — converting a
 * unit/memory into `catalog-src/` (or removing one) without updating its
 * ledger row should fail this test rather than go unnoticed.
 *
 * `raw/units/` and `raw/memories/` themselves are intentionally NOT checked
 * here: `raw/` is gitignored (local-only scraped source, never present in a
 * CI checkout), so a `readdirSync` against it fails with ENOENT in CI. The
 * ledger's raw file tallies (69 units / 32 memories) are maintained by hand
 * against the local `raw/` copy instead.
 */

function repoRootPath(...segments: string[]): string {
  return fileURLToPath(new URL(`../../../../${segments.join("/")}`, import.meta.url));
}

describe("catalog-src/ inventory (Issue #47 ledger)", () => {
  it("IT-CAT-INV-001: catalog-src/ has exactly the 22 converted units tallied in the ledger (10 representative + 12 from Issue #47)", () => {
    const source = readCatalogSource(repoRootPath("catalog-src"));
    expect(source.units.length).toBe(22);
  });

  it("IT-CAT-INV-002: catalog-src/ has exactly the 6 converted memories tallied in the ledger (Issue #47 batch)", () => {
    const source = readCatalogSource(repoRootPath("catalog-src"));
    expect(source.memories.length).toBe(6);
  });
});
