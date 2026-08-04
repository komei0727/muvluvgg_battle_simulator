/**
 * UT-NAMING-001 through UT-NAMING-003
 * 同一概念（対象／発生源／行動主体の `BattleUnitId`）を指す識別子名が1系統だけである
 * ことを、`apps/api/src` の全 TypeScript ソースを走査して機械的に保証する。
 *
 * 正本の名前は HTTP wire契約（`presentation/http/schemas/battle-log/battle-log-schema.ts`）
 * が公開している `targetUnitId` / `targetUnitIds` / `sourceUnitId` / `actorUnitId` に揃える。
 * 内部名を wire名と一致させておくことで、境界での読み替えが不要になる。
 *
 * `domain/catalog/integrity/**` と `infrastructure/catalog/runtime/catalog-cli.ts` の
 * `targetId` は `CatalogIntegrityViolation` が指すCatalog定義ID（`UNIT_*` 等）であり
 * `BattleUnitId` ではない別概念のため、走査対象から除外する。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiSrcPath = fileURLToPath(new URL("../..", import.meta.url));

/** `CatalogIntegrityViolation.targetId`（Catalog定義ID）だけを持つ位置。 */
const CATALOG_VIOLATION_TARGET_ID_PATHS: readonly string[] = [
  join("domain", "catalog", "integrity"),
  join("infrastructure", "catalog", "runtime", "catalog-cli.ts"),
  join("infrastructure", "catalog", "runtime", "catalog-file-loader.test.ts"),
];

function collectSourceFiles(dirPath: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(entryPath);
    }
  }
  return files;
}

function isCatalogViolationScope(filePath: string): boolean {
  const relativePath = relative(apiSrcPath, filePath);
  return CATALOG_VIOLATION_TARGET_ID_PATHS.some(
    (scope) => relativePath === scope || relativePath.startsWith(scope + sep),
  );
}

/**
 * 走査は識別子の語境界一致で行う。`retiredName` が別の長い識別子の一部
 * （`targetIds` に対する `targetIdsByUnit` 等）に含まれる場合を誤検知しないため。
 */
function findRetiredName(
  retiredName: string,
  options: { readonly skipCatalog: boolean },
): string[] {
  const pattern = new RegExp(String.raw`\b${retiredName}\b`);
  const hits: string[] = [];
  for (const filePath of collectSourceFiles(apiSrcPath)) {
    // 本ファイルは廃止名そのものを列挙するため、自身は走査対象から外す。
    if (filePath === fileURLToPath(import.meta.url)) {
      continue;
    }
    if (options.skipCatalog && isCatalogViolationScope(filePath)) {
      continue;
    }
    const lines = readFileSync(filePath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push(`${relative(apiSrcPath, filePath)}:${index + 1}`);
      }
    });
  }
  return hits;
}

describe("Unit ID naming — one name per concept", () => {
  it("UT-NAMING-001: the target BattleUnitId is named targetUnitId / targetUnitIds only", () => {
    const hits = [
      ...findRetiredName("targetId", { skipCatalog: true }),
      ...findRetiredName("targetIds", { skipCatalog: true }),
      ...findRetiredName("targetBattleUnitId", { skipCatalog: false }),
      ...findRetiredName("targetBattleUnitIds", { skipCatalog: false }),
    ].sort();
    expect(
      hits,
      `retired target-unit-ID names found; use targetUnitId / targetUnitIds: ${JSON.stringify(hits)}`,
    ).toEqual([]);
  });

  it("UT-NAMING-002: the source BattleUnitId is named sourceUnitId only", () => {
    const hits = [
      ...findRetiredName("sourceId", { skipCatalog: false }),
      ...findRetiredName("sourceBattleUnitId", { skipCatalog: false }),
    ].sort();
    expect(
      hits,
      `retired source-unit-ID names found; use sourceUnitId: ${JSON.stringify(hits)}`,
    ).toEqual([]);
  });

  it("UT-NAMING-003: the acting BattleUnitId is named actorUnitId only", () => {
    const hits = [
      ...findRetiredName("actorId", { skipCatalog: false }),
      ...findRetiredName("actorBattleUnitId", { skipCatalog: false }),
    ].sort();
    expect(
      hits,
      `retired actor-unit-ID names found; use actorUnitId: ${JSON.stringify(hits)}`,
    ).toEqual([]);
  });
});
