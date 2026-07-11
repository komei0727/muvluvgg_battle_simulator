import { generateCatalogCommand } from "./catalog-src-cli.js";

/**
 * `pnpm run generate-catalog -- <catalog-src-dir> <catalog-dir> <catalogRevision>`.
 * Deterministically regenerates `catalog/`'s five files plus `manifest.json`
 * from `catalog-src/` (Issue #50).
 */
const [catalogSrcDir, catalogDir, catalogRevision] = process.argv.slice(2);
if (catalogSrcDir === undefined || catalogDir === undefined || catalogRevision === undefined) {
  console.error("Usage: generate-catalog <catalog-src-dir> <catalog-dir> <catalogRevision>");
  process.exitCode = 1;
} else {
  const result = await generateCatalogCommand(catalogSrcDir, catalogDir, catalogRevision);
  if (result.ok) {
    console.log(
      `OK: generated Catalog at "${catalogDir}" from "${catalogSrcDir}" (catalogRevision=${result.catalogRevision}).`,
    );
    for (const file of result.filesWritten) {
      console.log(`  wrote ${file}`);
    }
    process.exitCode = 0;
  } else {
    console.error(`FAILED: could not generate Catalog at "${catalogDir}".`);
    console.error(result.message);
    process.exitCode = 1;
  }
}
