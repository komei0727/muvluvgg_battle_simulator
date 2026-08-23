/**
 * `apps/ui/src/test/fixtures/*.json`が`build-ui-fixtures.ts`の再生成結果と
 * byte-identicalであることを検査する（REF-053、Issue #598）。`check-openapi-types.mjs`
 * （REF-052）と同じ生成・検査ペアの規約——チェックは再生成結果をメモリ上で
 * 比較するだけで、コミット済みファイルを書き換えない。
 *
 * 実行方法:
 *   mise exec -- pnpm --filter api run check-ui-fixtures
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildUiFixtures } from "./build-ui-fixtures.js";
import { formatUiFixture } from "./format-ui-fixture.js";
import { UI_FIXTURES_DIR } from "./ui-fixtures-paths.js";

const fixtures = await buildUiFixtures();
let stale = false;

for (const [filename, value] of Object.entries(fixtures)) {
  const target = resolve(UI_FIXTURES_DIR, filename);
  const fresh = await formatUiFixture(filename, value);
  const committed = existsSync(target) ? readFileSync(target, "utf8") : undefined;

  if (committed === fresh) {
    console.log(`OK: "${target}" is up to date.`);
  } else {
    console.error(`FAILED: "${target}" is stale relative to the generator.`);
    stale = true;
  }
}

if (stale) {
  console.error("Run `pnpm --filter api run generate-ui-fixtures` to regenerate the stale files.");
  process.exitCode = 1;
}
