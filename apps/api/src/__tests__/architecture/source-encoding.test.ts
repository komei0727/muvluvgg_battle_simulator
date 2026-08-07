/**
 * UT-ENCODING-001
 * `apps/api` の著述テキスト（TypeScriptソースと`scripts/`）にNULバイト（`0x00`）が
 * 紛れ込んでいないことを機械的に保証する。
 *
 * NULを含むファイルをgitはバイナリとして扱い、`git diff`が
 * `Bin <n> -> <m> bytes`しか出さなくなる。GitHubのPR diffでも中身が表示されず、
 * その変更はレビュー不能になる。Prettier・ESLint・`tsc`・Vitestはいずれも
 * NULを問題として扱わないため、既存の品質ゲートはこれを素通りする
 * （REL-004／Issue #203で`openapi-breaking-change.ts`の文字列リテラルへ
 * 生の`0x00`が入り、実際にPR diffが非表示になった）。
 *
 * 制御文字全般ではなくNULだけを見るのは、タブ・改行など正当な制御文字と区別する
 * ためで、gitのバイナリ判定がNULの有無で決まることに合わせている。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = fileURLToPath(new URL("../../..", import.meta.url));

const SCANNED_ROOTS = ["src", "scripts"] as const;
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".json", ".md"] as const;

function collectTextFiles(dirPath: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTextFiles(entryPath));
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("source encoding", () => {
  it("UT-ENCODING-001: no authored text file contains a NUL byte, so git never treats a source change as an unreviewable binary diff", () => {
    const files = SCANNED_ROOTS.flatMap((root) => collectTextFiles(join(apiRoot, root)));
    expect(files.length).toBeGreaterThan(0);

    const offenders = files
      .filter((filePath) => readFileSync(filePath).includes(0x00))
      .map((filePath) => relative(apiRoot, filePath));

    expect(
      offenders,
      `NUL bytes make git diff these files as binary, hiding the change from review: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
