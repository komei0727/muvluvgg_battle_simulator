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
 * Issue #453 adds 3 more `raw/units/` conversions (`UNIT_URUU_SUMMER`,
 * `UNIT_MAO_SUMMER`, `UNIT_SHOUKA_BEACH` — 夏バリアント。いずれも既存
 * キャラクターの新衣装で `characterId` を再利用する), bringing the converted
 * unit total to 72. Issue #454 adds `UNIT_ANIS_SWEETDEVIL` (同じ夏バリアントの
 * 4体目。`DMG-012`/Issue #452 のエンジン拡張が前提), bringing it to 73.
 *
 * The 2026-08-12 memory batch adds 4 more `raw/memories/` conversions
 * (`MEM_KOI`, `MEM_LIKE_FRIENDS`, `MEM_GIDDY_CIRCUMSTANCES`,
 * `MEM_FANTASY_SCULPTOR_ROSIE`), bringing the memory total to 36.
 *
 * TEX-010 (Issue #447) adds `EXERCISE_ENEMY` units — tactical-exercise-only
 * enemies transcribed from in-game screenshots, not `raw/units/` conversions.
 * They are tallied separately (`IT-CAT-INV-003`, ledger section
 * 「戦術演習ユニット」in `15_Unit_Memory変換台帳.md`) and excluded from the
 * converted-unit count for the same reason INTERNAL fixtures are. Issues
 * #470/#471/#472 add three more (`UNIT_ANIS_SWEETDEVIL_TEX`,
 * `UNIT_SHOUKA_BEACH_TEX`, `UNIT_MAO_SUMMER_TEX`), leaving the converted-unit
 * total at 73.
 */

function apiPackageRootPath(...segments: string[]): string {
  return fileURLToPath(new URL(`../../../../${segments.join("/")}`, import.meta.url));
}

describe("catalog-src/ inventory (Issue #47 ledger)", () => {
  it("IT-CAT-INV-001: catalog-src/ has exactly the 73 converted units tallied in the ledger (22 from Issue #47 + 8 from Issue #55 Batch A + 8 from Issue #59 Batch B + 8 from Issue #57 Batch C + 8 from Issue #56 Batch D + 8 from Issue #58 Batch E + 7 from Issue #60 Batch F + 3 from Issue #453 夏バリアント + 1 from Issue #454 アニス・ベネット), excluding synthetic INTERNAL fixtures", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    const converted = source.units.filter(
      (unit) =>
        !((unit as { metadata?: { tags?: readonly string[] } }).metadata?.tags ?? []).includes(
          "INTERNAL",
        ) && (unit as { category?: string }).category !== "EXERCISE_ENEMY",
    );
    expect(converted).toHaveLength(73);
  });

  it("IT-CAT-INV-002: catalog-src/ has all 36 converted memories tallied in the ledger (6 from Issue #47 + 6 from Issue #178 M7-007 + 20 from Issue #176 M7-008 + 4 from the 2026-08-12 追加バッチ)", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    expect(source.memories.length).toBe(36);
  });

  it("IT-CAT-INV-003: catalog-src/ has exactly the EXERCISE_ENEMY units tallied in the ledger's 戦術演習ユニット section (TEX-010 / Issue #447, Issues #470-#472)", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    const exerciseEnemies = source.units
      .filter((unit) => (unit as { category?: string }).category === "EXERCISE_ENEMY")
      .map((unit) => (unit as { unitDefinitionId: string }).unitDefinitionId)
      .sort();
    expect(exerciseEnemies).toEqual([
      "UNIT_ANIS_SWEETDEVIL_TEX",
      "UNIT_AOI_GUARDIAN_TEX",
      "UNIT_MAO_SUMMER_TEX",
      "UNIT_SHOUKA_BEACH_TEX",
    ]);
  });
});
