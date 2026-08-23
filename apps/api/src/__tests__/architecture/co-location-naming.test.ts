/**
 * UT-COLOC-001 / UT-COLOC-002
 * co-location 命名規約（REF-013／Issue #316 — 「テストファイル名は必ず対象実装の
 * モジュール名で始める」）を、`UT-MOD-027`／`028`と同じ実ディレクトリ走査で機械強制する
 * （REF-050／Issue #595）。
 *
 * `*.test.ts(x)` の先頭セグメント（最初のドットまで）と同名の `.ts(x)` が同じ
 * ディレクトリに実在しない場合、対象実装の名を騙っていることになる。この規約は
 * `12_テスト戦略.md`「ファイル名から対象実装が辿れること」節が定め、そこへ移すと
 * 検証できなくなるテスト（横断不変条件・実サーバー経由でしか観測できないHTTP契約など）
 * だけを `NAMING_EXCEPTIONS` の例外として許す。例外の一覧はここがコード側の正本であり、
 * ドキュメント側では重複させない。
 *
 * `src/__tests__/` はカテゴリ別の横断テストバケツであり、個々のファイルが対象実装の
 * モジュール名を名乗る前提がそもそも無いため（本ファイル自身を含む）、走査から除外する。
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiSrcPath = fileURLToPath(new URL("../..", import.meta.url));
const crossCuttingBucket = join(apiSrcPath, "__tests__");

/**
 * 対象モジュール名を名乗らない co-location 側テストの例外一覧（正本）。
 * `apiSrcPath`からの相対パス（`.test.ts(x)`拡張子を除く）で管理する — basenameだけで
 * 照合すると、別ディレクトリにある無関係な同名ファイル（例: 別ディレクトリの
 * `openapi.test.ts`）まで誤って例外に一致し、規約違反を見逃す。
 * 新しくこの形のテストを追加するときはここへ、対象実装名で判別できない理由の
 * コメント付きで追記する。
 */
const NAMING_EXCEPTIONS: readonly string[] = [
  // 対象ディレクトリ内の実装群を総なめする不変条件（1ファイルに分散すると守れない）
  "domain/catalog/definitions/immutability", // 定義ファクトリ横断の凍結不変条件
  "testing/fixtures/fixtures", // 共有ヘルパ群の契約をディレクトリ単位で固定
  "infrastructure/catalog/runtime/catalog-production-units", // Issue #46 由来の Catalog 昇格ゲート
  "infrastructure/catalog/source/catalog-src-inventory", // catalog-src/ 変換件数の正本
  "infrastructure/catalog/source/catalog-src-production", // catalog-src/ ⇄ catalog/ の再生成一致

  // `docs/` の台帳自体を対象とする照合
  "testing/traceability/scenario-coverage", // 12_テスト戦略.md の基準シナリオ表の実在監視

  // 実サーバー経由でしか観測できないHTTP契約（対象はroutes/配下だがhttp/直下に置く）
  "presentation/http/battle-simulation-catalog-route", // 対象は routes/catalog-route.ts
  "presentation/http/formation-stat-preview-route", // 対象は routes/formation-stat-preview-route.ts
  "presentation/http/tactical-exercise-route", // 対象は routes/tactical-exercise-route.ts
  "presentation/http/tactical-exercise-evaluation-route", // 対象は routes/tactical-exercise-evaluation-route.ts
  "presentation/http/simulation-route.log-level-projection", // 対象は routes/simulation-route.ts
  "presentation/http/simulation-route.memory-granted-marker", // 対象は routes/simulation-route.ts

  // 特定の1モジュールに対応しない横断的なOpenAPI文書検査
  "presentation/http/openapi",
  "presentation/http/openapi-compatibility",

  // 複数エンドポイントの状態復元契約を横断する文書検査
  "presentation/http/state-restoration",
];

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

function hasSiblingImplementation(testFilePath: string): boolean {
  const dir = dirname(testFilePath);
  const leadingSegment = leadingSegmentOf(testFilePath);
  return (
    existsSync(join(dir, `${leadingSegment}.ts`)) || existsSync(join(dir, `${leadingSegment}.tsx`))
  );
}

/** `apiSrcPath`からの相対パス（`.test.ts(x)`拡張子を除く）。`NAMING_EXCEPTIONS`の照合キー。 */
function exceptionKeyOf(testFilePath: string): string {
  return relative(apiSrcPath, testFilePath).replace(/\.test\.tsx?$/, "");
}

/** 例外キーに対応する実在の `.test.ts(x)` の絶対パス。無ければ`undefined`。 */
function testFilePathForExceptionKey(key: string): string | undefined {
  const tsPath = join(apiSrcPath, `${key}.test.ts`);
  if (existsSync(tsPath)) {
    return tsPath;
  }
  const tsxPath = join(apiSrcPath, `${key}.test.tsx`);
  return existsSync(tsxPath) ? tsxPath : undefined;
}

describe("Co-location naming convention (REF-013 / #316, enforced by REF-050 / #595)", () => {
  it("UT-COLOC-001: every co-located test file's leading segment matches a sibling implementation file, or is a registered exception", () => {
    const testFiles = collectTestFiles(apiSrcPath);
    const violations = testFiles
      .filter((f) => !hasSiblingImplementation(f) && !NAMING_EXCEPTIONS.includes(exceptionKeyOf(f)))
      .map((f) => relative(apiSrcPath, f))
      .sort();
    expect(
      violations,
      `test file(s) name a module they don't implement and aren't a registered exception: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("UT-COLOC-002: every registered exception still needs to be one", () => {
    const stale = NAMING_EXCEPTIONS.filter((key) => {
      const filePath = testFilePathForExceptionKey(key);
      return filePath === undefined || hasSiblingImplementation(filePath);
    }).sort();
    expect(
      stale,
      `stale NAMING_EXCEPTIONS entries — no longer needed or no longer match a test file: ${JSON.stringify(stale)}`,
    ).toEqual([]);
  });
});
