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
 * 新しくこの形のテストを追加するときはここへ、対象実装名で判別できない理由の
 * コメント付きで追記する。
 */
const NAMING_EXCEPTIONS: readonly string[] = [
  // 対象ディレクトリ内の実装群を総なめする不変条件（1ファイルに分散すると守れない）
  "immutability", // domain/catalog/definitions — 定義ファクトリ横断の凍結不変条件
  "fixtures", // testing/fixtures — 共有ヘルパ群の契約をディレクトリ単位で固定
  "catalog-production-units", // infrastructure/catalog/runtime — Issue #46 由来の Catalog 昇格ゲート
  "catalog-src-inventory", // infrastructure/catalog/source — catalog-src/ 変換件数の正本
  "catalog-src-production", // infrastructure/catalog/source — catalog-src/ ⇄ catalog/ の再生成一致

  // `docs/` の台帳自体を対象とする照合
  "scenario-coverage", // testing/traceability — 12_テスト戦略.md の基準シナリオ表の実在監視

  // 実サーバー経由でしか観測できないHTTP契約（対象はroutes/配下だがhttp/直下に置く）
  "battle-simulation-catalog-route", // 対象は routes/catalog-route.ts
  "formation-stat-preview-route", // 対象は routes/formation-stat-preview-route.ts
  "tactical-exercise-route", // 対象は routes/tactical-exercise-route.ts
  "tactical-exercise-evaluation-route", // 対象は routes/tactical-exercise-evaluation-route.ts
  "simulation-route.log-level-projection", // 対象は routes/simulation-route.ts
  "simulation-route.memory-granted-marker", // 対象は routes/simulation-route.ts

  // 特定の1モジュールに対応しない横断的なOpenAPI文書検査
  "openapi",
  "openapi-compatibility",

  // 複数エンドポイントの状態復元契約を横断する文書検査
  "state-restoration",
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
  it("UT-COLOC-001: every co-located test file's leading segment matches a sibling implementation file, or is a registered exception", () => {
    const testFiles = collectTestFiles(apiSrcPath);
    const violations = testFiles
      .filter((f) => !hasSiblingImplementation(f) && !NAMING_EXCEPTIONS.includes(baseNameOf(f)))
      .map((f) => relative(apiSrcPath, f))
      .sort();
    expect(
      violations,
      `test file(s) name a module they don't implement and aren't a registered exception: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("UT-COLOC-002: every registered exception still needs to be one", () => {
    const testFiles = collectTestFiles(apiSrcPath);
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
