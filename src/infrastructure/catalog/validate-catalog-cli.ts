import { validateCatalogDirectory } from "./catalog-cli.js";

/**
 * `pnpm run validate-catalog -- <catalog-directory>`. See
 * `11_インフラストラクチャ設計.md`「Catalog検証CLI」for the error contract.
 */
const catalogDir = process.argv[2];
if (catalogDir === undefined) {
  console.error("Usage: validate-catalog <catalog-directory>");
  process.exitCode = 1;
} else {
  const result = validateCatalogDirectory(catalogDir);
  if (result.ok) {
    console.log(
      `OK: Catalog at "${catalogDir}" is valid (catalogRevision=${result.catalogRevision}).`,
    );
    process.exitCode = 0;
  } else {
    console.error(`FAILED: Catalog at "${catalogDir}" is invalid.`);
    console.error(result.message);
    process.exitCode = 1;
  }
}
