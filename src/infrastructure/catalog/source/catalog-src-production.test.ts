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
        "UNIT_EVIE_ECO",
        "UNIT_FLUTE_VAMPIRE",
        "UNIT_HARRIET_SAGE",
        "UNIT_KARINA_DOWNER",
        "UNIT_KATE_PALADIN",
        "UNIT_KOTOHA_REBEL",
        "UNIT_LAURA_MOUNTAIN",
        "UNIT_LYDIA_GENIUS",
        "UNIT_MIKOTO_SURVIVOR",
        "UNIT_STELLA_STATUE",
        // Issue #47 先行バッチ（残Unit/Memory基礎Catalog整備）
        "UNIT_ANIS_TROUBLEMAKER",
        "UNIT_CHIYURU_MAZE",
        "UNIT_DOROTHEA_GRACE",
        "UNIT_EVIE_KYONSHI",
        "UNIT_FEE_ACTOR",
        "UNIT_JUNKA_CHILDHOOD",
        "UNIT_KEI_JACKKNIFE",
        "UNIT_LAYLA_ENTREPRENEUR",
        "UNIT_SAYA_BUNNY",
        "UNIT_SAYA_LONGING",
        "UNIT_SUIRAN_CHAOS",
        "UNIT_YURIA_WILDCARD",
        // Issue #55 Batch A（既存キャラクター別バージョン8件）
        "UNIT_YURIA_YUKATA",
        "UNIT_FLUTE_INFLUENCER",
        "UNIT_SUIRAN_CASINO",
        "UNIT_DOROTHEA_PIONEER",
        "UNIT_CHIYURU_NEWYEAR",
        "UNIT_FEE_BATH",
        "UNIT_MAIA_SALON",
        "UNIT_MAIA_LAZY",
        // Issue #59 Batch B（複数バージョン整合性8件）
        "UNIT_AOI_ELEGANT",
        "UNIT_AOI_GUARDIAN",
        "UNIT_LILY_HERO",
        "UNIT_LILY_SINGER",
        "UNIT_SHIRANA_LUCKY",
        "UNIT_SHIRANA_SORA",
        "UNIT_CLARA_TSUNDERE",
        "UNIT_CLARA_SANTA",
        // Issue #57 Batch C（所属/チーム系候補8件）
        "UNIT_MERU_SIRIUS",
        "UNIT_MERU_FLATSPIN",
        "UNIT_SIENA_DIVA",
        "UNIT_SIENA_OFFSTAGE",
        "UNIT_LUCIE_MAID",
        "UNIT_LUCIE_COMPANION",
        "UNIT_RAMI_NEWYEAR",
        "UNIT_RAMI_UNYIELDING",
        // Issue #56 Batch D（戦術/前衛寄りUnit8件）
        "UNIT_MEIYA_FATED",
        "UNIT_YUI_HEIR",
        "UNIT_OLGA_VETERAN",
        "UNIT_HIIRO_LONEWOLF",
        "UNIT_MIHIME_SNIPER",
        "UNIT_NOEL_RUMBLE",
        "UNIT_TARISA_TROUBLEMAKER",
        "UNIT_SHOUKA_SCHEMER",
        // Issue #58 Batch E（支援/制御/イベント色の強いUnit8件）
        "UNIT_NANAE_COMMANDER",
        "UNIT_SENKA_CHRISTMAS",
        "UNIT_SENKA_SCHEMER",
        "UNIT_KOKORO_SPORTSDAY",
        "UNIT_MAO_COMMITTEE",
        "UNIT_CHIZURU_DOMESTIC",
        "UNIT_MIRIAM_MAGE",
        "UNIT_LUNA_HUNGRY",
        // Issue #60 Batch F（残Unit仕上げ7件）
        "UNIT_ELENA_MOODMAKER",
        "UNIT_TATIANA_SAGE",
        "UNIT_ROSIE_ARTIST",
        "UNIT_URUU_TIMID",
        "UNIT_RAVEL_MODEL",
        "UNIT_NADYA_SUCCESSOR",
        "UNIT_JULIE_SNOW",
        // Issue #106（synthetic, zero-requiredCapabilities CI smoke-test unit）
        "UNIT_CI_SMOKE_TEST",
      ].sort(),
    );
  });

  it("IT-CAT-SRCPROD-003: catalog/ regenerated from catalog-src/ still loads without an integrity violation", () => {
    const catalog = loadCatalogFromDirectory(join(repoRootPath("catalog")));
    expect(catalog.catalogRevision).toBe(catalogRevision());
  });
});
