import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogSource } from "./catalog-src-aggregator.js";

/**
 * `catalog-src/` の変換済み件数の正本。ここで固定する期待件数（変換済み Unit 76 /
 * Memory 37 / EXERCISE_ENEMY 4）が唯一の台帳であり、Unit・Memory を追加・削除する
 * PR は同じ PR でこの期待値を更新する。黙った増減（変換したのに数え漏れる、
 * 消したのに気づかれない）をここで検出する。
 *
 * `raw/units/`・`raw/memories/` 自体は意図的に検査しない: `raw/` は gitignore 済みの
 * ローカル専用ディレクトリで、CI checkout には存在しないため `readdirSync` が
 * ENOENT で落ちる。
 *
 * 変換済み Unit の数え方: `INTERNAL` タグ付きは合成フィクスチャ、
 * `EXERCISE_ENEMY` カテゴリは戦術演習専用敵（ゲーム内スクリーンショットからの
 * 転記で `raw/units/` 変換ではない）なので、どちらも変換済み件数から除外し、
 * EXERCISE_ENEMY は別枠（`IT-CAT-INV-003`）で ID を固定する。ディレクトリ総数を
 * 数えると合成 Unit の追加がここで失敗し、期待値の書き換えで通す誘惑を生むため、
 * 区分ごとに数える。
 */

function apiPackageRootPath(...segments: string[]): string {
  return fileURLToPath(new URL(`../../../../${segments.join("/")}`, import.meta.url));
}

describe("catalog-src/ inventory", () => {
  it("IT-CAT-INV-001: catalog-src/ has exactly 76 converted units, excluding synthetic INTERNAL fixtures and EXERCISE_ENEMY units", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    const converted = source.units.filter(
      (unit) =>
        !((unit as { metadata?: { tags?: readonly string[] } }).metadata?.tags ?? []).includes(
          "INTERNAL",
        ) && (unit as { category?: string }).category !== "EXERCISE_ENEMY",
    );
    expect(converted).toHaveLength(76);
  });

  it("IT-CAT-INV-002: catalog-src/ has exactly 37 converted memories", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    expect(source.memories.length).toBe(37);
  });

  it("IT-CAT-INV-003 [R-TEX-11]: catalog-src/ has exactly the expected EXERCISE_ENEMY units", () => {
    const source = readCatalogSource(apiPackageRootPath("catalog-src"));
    const exerciseEnemies = source.units
      .filter((unit) => (unit as { category?: string }).category === "EXERCISE_ENEMY")
      .map((unit) => (unit as { unitDefinitionId: string }).unitDefinitionId)
      .sort();
    expect(exerciseEnemies).toEqual([
      "UNIT_ANIS_SWEETDEVIL_TEX",
      "UNIT_AOI_GUARDIAN_TEX",
      "UNIT_MAO_SUMMER_TEX",
      "UNIT_SHIRANA_LUCKY_TEX",
      "UNIT_SHOUKA_BEACH_TEX",
    ]);
  });

  it("IT-CAT-INV-004: no production definition anywhere in catalog-src grants a marker that could stand for 「ワンペア」, so SKL_SUIRAN_CASINO_AS1's 2-target branch stays unreachable", () => {
    // `SKL_SUIRAN_CASINO_AS1` の2対象分岐は「原文語『ワンペア』に対応する Marker を
    // 配る手段が production 定義に存在しない」という到達不能判断を根拠に未実装の
    // ままにしている（Issue #200）。このテストはその判断が維持されていることの
    // 常設の見張りであり、失敗したら対象拡張を近似なしへ実装し直す必要がある。
    //
    // Markerは `markerId` しか持たず表示名を持たないため、原文語「ワンペア」との
    // 対応は**ID表記**でしか機械判定できない。ローマ字化の揺れを拾うため
    // `PAIR` を含むIDを全面的に禁じ、併せて劉翠蘭自身が配るMarkerが
    // 「スリーカード」1種のままであることを固定する。
    const grantedMarkerIds = (directory: string): readonly string[] => {
      const root = apiPackageRootPath("catalog-src", directory);
      return readdirSync(root)
        .flatMap((entry) =>
          readdirSync(`${root}/${entry}`)
            .filter((file) => file.endsWith(".json"))
            .map((file) => readFileSync(`${root}/${entry}/${file}`, "utf8")),
        )
        .flatMap((source) => [...source.matchAll(/"markerId":\s*"([A-Z0-9_]+)"/g)])
        .map((match) => match[1]!);
    };
    const allMarkerIds = [...grantedMarkerIds("units"), ...grantedMarkerIds("memories")];

    // 空振り防止: 走査がMarkerを1件も拾えていないなら、下の2つの不在は無意味になる。
    expect(allMarkerIds.length).toBeGreaterThan(0);
    expect(allMarkerIds.filter((markerId) => markerId.includes("PAIR"))).toEqual([]);
    expect([...new Set(grantedMarkerIds("units").filter((id) => id.includes("SUIRAN_CASINO")))]) //
      .toEqual(["MARKER_SUIRAN_CASINO_THREE_CARD"]);
  });
});
