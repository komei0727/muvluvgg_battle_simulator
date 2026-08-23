/**
 * co-location 命名規約（REF-013／Issue #316 — 「テストファイル名は必ず対象実装の
 * モジュール名で始める」）を、`apps/api`の`UT-COLOC-001`／`002`と同じ実ディレクトリ走査で
 * `apps/ui/src`へも機械強制する（REF-050／Issue #595）。
 *
 * `*.test.ts(x)` の先頭セグメント（最初のドットまで）と同名の `.ts(x)` が同じ
 * ディレクトリに実在しない場合、対象実装の名を騙っていることになる。`src/__tests__/`は
 * カテゴリ別の横断テストバケツであり、個々のファイルが対象実装のモジュール名を名乗る
 * 前提がそもそも無いため（本ファイル自身を含む）、走査から除外する。
 *
 * 現時点の `apps/ui/src` に例外は無い（`NAMING_EXCEPTIONS` は空）。将来この形の
 * テストを追加するときは、対象実装名で判別できない理由のコメント付きでここへ追記する。
 *
 * `tsconfig.app.json` はブラウザ実行を前提に `types: ["vite/client"]` のみを持ち
 * Node組み込みの型を含まないため、このファイルだけ明示的に `node` 型を参照する。
 */
/// <reference types="node" />
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom環境ではimport.meta.urlがfile:スキームを持たないため（location.hrefに引きずられる）、
// fileURLToPathではなくVitestのプロジェクトルート（apps/ui/）を起点にする。
const uiSrcPath = join(process.cwd(), "src");
const crossCuttingBucket = join(uiSrcPath, "__tests__");

const NAMING_EXCEPTIONS: readonly string[] = [];

function collectTestFiles(dirPath: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entryPath === crossCuttingBucket) {
        continue;
      }
      files.push(...collectTestFiles(entryPath));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function leadingSegmentOf(testFilePath: string): string {
  // split(".") always yields at least one element, even with no "." in the input.
  return (
    basename(testFilePath)
      .replace(/\.test\.tsx?$/, "")
      .split(".")[0] ?? ""
  );
}

function baseNameOf(testFilePath: string): string {
  return basename(testFilePath).replace(/\.test\.tsx?$/, "");
}

function hasSiblingImplementation(testFilePath: string): boolean {
  const dir = dirname(testFilePath);
  const leadingSegment = leadingSegmentOf(testFilePath);
  return (
    existsSync(join(dir, `${leadingSegment}.ts`)) || existsSync(join(dir, `${leadingSegment}.tsx`))
  );
}

describe("Co-location naming convention (REF-013 / #316, enforced by REF-050 / #595)", () => {
  it("every co-located test file's leading segment matches a sibling implementation file, or is a registered exception", () => {
    const testFiles = collectTestFiles(uiSrcPath);
    const violations = testFiles
      .filter((f) => !hasSiblingImplementation(f) && !NAMING_EXCEPTIONS.includes(baseNameOf(f)))
      .map((f) => relative(uiSrcPath, f))
      .sort();
    expect(
      violations,
      `test file(s) name a module they don't implement and aren't a registered exception: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("every registered exception still needs to be one", () => {
    const testFiles = collectTestFiles(uiSrcPath);
    const byBaseName = new Map(testFiles.map((f) => [baseNameOf(f), f]));
    const stale = NAMING_EXCEPTIONS.filter((name) => {
      const filePath = byBaseName.get(name);
      return filePath === undefined || hasSiblingImplementation(filePath);
    }).sort();
    expect(
      stale,
      `stale NAMING_EXCEPTIONS entries — no longer needed or no longer match a test file: ${JSON.stringify(stale)}`,
    ).toEqual([]);
  });
});
