import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectTestCaseDefinitions } from "@muvluvgg/api/src/testing/traceability/test-case-definitions.js";

/**
 * `UI-AC-*`（受け入れ条件、`01_UI要求・画面設計.md`）とテストの突合を、失敗させずに
 * 一覧出力だけする（Issue #602 受入条件、`06_UIテスト戦略.md` `UI-TEST-001`）。
 * `UI-AC-*`は1受け入れ条件を複数テストが分担して検証してよい設計書側の語彙であり、
 * `UI-CT-*`のような1テスト1IDの対応を前提にできないため、`test-case-id-collision.test.ts`
 * の衝突検査（1IDにつき1テストのみを許す）とは別の、非failingな監査に留める。
 * 埋まってからの必須化方針は`06_UIテスト戦略.md` §11に記す。
 */

// jsdom環境ではimport.meta.urlがfile:スキームを持たないため（location.hrefに引きずられる）、
// fileURLToPathではなくVitestのプロジェクトルート（apps/ui/）を起点にする
// （co-location-naming.test.tsと同じ回避策）。
const uiSrcPath = join(process.cwd(), "src");
const uiRequirementsSpecPath = join(
  process.cwd(),
  "..",
  "..",
  "docs",
  "ui-design",
  "01_UI要求・画面設計.md",
);

// `REF-023`（Issue #352）のCapability廃止で退役し、IDが欠番のまま残っている。
const RETIRED_UI_AC_IDS: ReadonlySet<string> = new Set(["UI-AC-014"]);

describe("UI-AC-* traceability report (non-failing)", () => {
  it("UI-TEST-009: reports UI-AC-* acceptance criteria not yet cited by any test", () => {
    const specText = readFileSync(uiRequirementsSpecPath, "utf8");
    const definedIds = new Set(
      [...specText.matchAll(/`(UI-AC-\d+)`/g)]
        .map((match) => match[1])
        .filter((id): id is string => id !== undefined && !RETIRED_UI_AC_IDS.has(id)),
    );

    const definitions = collectTestCaseDefinitions(uiSrcPath, undefined, /\bUI-AC-\d+\b/g);
    const uncovered = [...definedIds]
      .filter((id) => (definitions.get(id) ?? []).length === 0)
      .sort();

    const coveragePercent = Math.round(
      ((definedIds.size - uncovered.length) / definedIds.size) * 100,
    );
    console.log(
      `UI-AC-* coverage: ${definedIds.size - uncovered.length}/${definedIds.size} (${coveragePercent}%). ` +
        `Uncovered: ${uncovered.length === 0 ? "none" : uncovered.join(", ")}`,
    );

    expect(definedIds.size).toBeGreaterThan(0);
  });
});
