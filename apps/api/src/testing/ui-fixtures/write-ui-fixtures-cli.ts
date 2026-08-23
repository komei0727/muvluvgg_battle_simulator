/**
 * `apps/ui/src/test/fixtures/*.json`を再生成する（REF-053、Issue #598）。
 * `docs/ui-design/06_UIテスト戦略.md`§5が定める7ファイルは実サーバーから生成された
 * contract fixtureであり、API側のレスポンス形が変わればここを再生成しないかぎり
 * `check-ui-fixtures-cli.ts`（`mise run check-ui-fixtures`）がdriftとして検出する。
 *
 * 実行方法:
 *   mise exec -- pnpm --filter api run generate-ui-fixtures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { buildUiFixtures } from "./build-ui-fixtures.js";
import { formatUiFixture } from "./format-ui-fixture.js";
import { UI_FIXTURES_DIR } from "./ui-fixtures-paths.js";

const fixtures = await buildUiFixtures();
mkdirSync(UI_FIXTURES_DIR, { recursive: true });
for (const [filename, value] of Object.entries(fixtures)) {
  const target = resolve(UI_FIXTURES_DIR, filename);
  writeFileSync(target, await formatUiFixture(filename, value));
  stdout.write(`wrote ${target}\n`);
}
