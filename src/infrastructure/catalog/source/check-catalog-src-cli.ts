import { checkCatalogSrcCommand } from "./catalog-src-cli.js";

/**
 * `pnpm run check-catalog-src -- <catalog-src-dir> <catalog-dir>`. Fails if
 * `catalog/` is not what regenerating from `catalog-src/` (with the
 * catalogRevision already committed in `catalog/manifest.json`) would
 * produce — i.e. catalog-src/ and catalog/ have drifted apart (Issue #50).
 */
const [catalogSrcDir, catalogDir] = process.argv.slice(2);
if (catalogSrcDir === undefined || catalogDir === undefined) {
  console.error("Usage: check-catalog-src <catalog-src-dir> <catalog-dir>");
  process.exitCode = 1;
} else {
  const result = await checkCatalogSrcCommand(catalogSrcDir, catalogDir);
  if (!result.ok) {
    console.error(`FAILED: could not check Catalog at "${catalogDir}".`);
    console.error(result.message);
    process.exitCode = 1;
  } else if (result.upToDate) {
    console.log(`OK: "${catalogDir}" is up to date with "${catalogSrcDir}".`);
    process.exitCode = 0;
  } else {
    console.error(`FAILED: "${catalogDir}" is stale relative to "${catalogSrcDir}".`);
    for (const file of result.diffFiles) {
      console.error(`  drifted: ${file}`);
    }
    console.error("Run `pnpm run generate-catalog` to regenerate it.");
    process.exitCode = 1;
  }
}
