import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectTestCaseDefinitions } from "@muvluvgg/api/src/testing/traceability/test-case-definitions.js";

/**
 * UIのテストタイトルに載る `UI-*` ID（`UI-CT-*`／`UI-AC-*`／`UI-CMP-*`／`UI-API-*`／
 * `UI-UC-*`／`UI-UT-*`／`UI-E2E-*`など）が、設計書の1項目と実行対象テストの1:1対応で
 * あることを機械検査する。収集器（TypeScript Compiler API）はAPI側
 * （`apps/api/src/testing/traceability/test-case-definitions.ts`）と共有し、`src`
 * ルートとIDパターンを引数化した既存の形をそのまま呼ぶ（REF-057、Issue #602）。
 */
const UI_TEST_CASE_ID_PATTERN = /\bUI-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;

// jsdom環境ではimport.meta.urlがfile:スキームを持たないため（location.hrefに引きずられる）、
// fileURLToPathではなくVitestのプロジェクトルート（apps/ui/）を起点にする
// （co-location-naming.test.tsと同じ回避策）。
const uiSrcPath = join(process.cwd(), "src");

describe("UI test case id collision", () => {
  it("UI-TEST-008: every UI test case id maps to exactly one executable test", () => {
    const definitions = collectTestCaseDefinitions(uiSrcPath, undefined, UI_TEST_CASE_ID_PATTERN);
    const ambiguous = [...definitions.entries()]
      .filter(([, defs]) => defs.length > 1)
      .map(([id, defs]) => `${id}: ${defs.map((d) => d.file.replace(uiSrcPath, "")).join(", ")}`)
      .sort();
    expect(
      ambiguous,
      "同じIDを複数のitが名乗っている。どのテストが対象IDの証跡か特定できないため、" +
        "重複しないIDへ採番し直すこと（06_UIテスト戦略.md）。",
    ).toEqual([]);
  }, 30000);
});
