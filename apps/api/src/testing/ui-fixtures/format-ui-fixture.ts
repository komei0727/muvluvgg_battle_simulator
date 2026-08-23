import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import { UI_FIXTURES_DIR } from "./ui-fixtures-paths.js";

/**
 * `write-openapi-baseline.mjs`と同じ理由でPrettierを通す。素の`JSON.stringify`を
 * そのままコミットすると`format:check`（品質ゲート）が整形差分で落ちる。`null, 2`で
 * 展開してから渡すのは、Prettierの出力が入力の改行位置を引き継ぐため
 * ——詰めた1行のままだとcontract fixtureとしての行単位diffがレビューで読めなくなる。
 */
export async function formatUiFixture(filename: string, value: unknown): Promise<string> {
  const target = resolve(UI_FIXTURES_DIR, filename);
  const options = await resolveConfig(target);
  return format(JSON.stringify(value, null, 2), { ...options, filepath: target });
}
