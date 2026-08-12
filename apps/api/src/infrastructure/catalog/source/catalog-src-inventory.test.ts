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
 *
 * Issue #55 (Batch A of Issue #54) adds 8 more units, bringing the total to
 * 30 (22 from Issue #47 + 8 from that batch). Issue #59 (Batch B of Issue
 * #54) adds another 8 units, bringing the total to 38. Issue #57 (Batch C of
 * Issue #54) adds another 8 units, bringing the total to 46. Issue #56
 * (Batch D of Issue #54) adds another 8 units, bringing the total to 54.
 * Issue #58 (Batch E of Issue #54) adds another 8 units, bringing the total
 * to 62. Issue #60 (Batch F of Issue #54) adds the remaining 7 units,
 * bringing the total to 69.
 *
 * Issue #106 review (2026-07-15) added a 70th unit, `UNIT_CI_SMOKE_TEST` — a
 * synthetic, zero-`requiredCapabilities` unit that existed solely so
 * production Catalog had at least one `selectable` unit for the Cloud Run
 * CI/CD post-deploy simulation smoke test. `REL-002` (Issue #199) removed it
 * once every converted character unit became `selectable` on `IMPLEMENTED`
 * capabilities alone (`DMG-006`/Issue #188).
 *
 * This test counts CONVERTED units only — units carrying the `INTERNAL` tag
 * are synthetic fixtures, are not `raw/units/` conversions, and belong to a
 * separate tally owned by `UT-PLAN-001-005`. Counting the directory total
 * instead would conflate the two: re-adding a synthetic unit would fail here
 * and invite editing the ledger's converted-unit constant to make it pass.
 *
 * TEX-010 (Issue #447) adds `EXERCISE_ENEMY` units — tactical-exercise-only
 * enemies transcribed from in-game screenshots, not `raw/units/` conversions.
 * They are tallied separately (`IT-CAT-INV-003`, ledger section
 * 「戦術演習ユニット」in `15_Unit_Memory変換台帳.md`) and excluded from the
 * converted-unit count for the same reason INTERNAL fixtures are.
 */

function apiPackageRootPath(...segments: string[]): string {
  return fileURLToPath(new URL(`../../../../${segments.join("/")}`, import.meta.url));
}

describe("catalog-src/ inventory (Issue #47 ledger)", () => {
  it("IT-CAT-INV-001: catalog-src/ has exactly the 69 converted units tallied in the ledger (22 from Issue #47 + 8 from Issue #55 Batch A + 8 from Issue #59 Batch B + 8 from Issue #57 Batch C + 8 from Issue #56 Batch D + 8 from Issue #58 Batch E + 7 from Issue #60 Batch F), excluding synthetic INTERNAL fixtures", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    const converted = source.units.filter(
      (unit) =>
        !((unit as { metadata?: { tags?: readonly string[] } }).metadata?.tags ?? []).includes(
          "INTERNAL",
        ) && (unit as { category?: string }).category !== "EXERCISE_ENEMY",
    );
    expect(converted).toHaveLength(69);
  });

  it("IT-CAT-INV-002: catalog-src/ has all 32 converted memories tallied in the ledger (6 from Issue #47 + 6 from Issue #178 M7-007 + 20 from Issue #176 M7-008)", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    expect(source.memories.length).toBe(32);
  });

  it("IT-CAT-INV-003: catalog-src/ has exactly the EXERCISE_ENEMY units tallied in the ledger's 戦術演習ユニット section (TEX-010 / Issue #447)", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    const exerciseEnemies = source.units
      .filter((unit) => (unit as { category?: string }).category === "EXERCISE_ENEMY")
      .map((unit) => (unit as { unitDefinitionId: string }).unitDefinitionId)
      .sort();
    expect(exerciseEnemies).toEqual(["UNIT_AOI_GUARDIAN_TEX"]);
  });
});
