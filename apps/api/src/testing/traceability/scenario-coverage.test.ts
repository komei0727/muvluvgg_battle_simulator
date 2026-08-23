import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RETIRED_TEST_CASE_IDS } from "./retired-test-case-ids.js";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

/**
 * 基準シナリオ（`SCN-BTL-*`）の実在監視。基準シナリオの多くはルールカバレッジ台帳
 * （`rule-coverage.ts`）に載らないため、この監視がないとシナリオテストの黙った削除
 * （ファイルごと消える・`it.skip` 化する）を検出する仕組みがなくなる。
 * ここで凍結した集合が実行対象のテストとして実在し続けることだけを検証し、
 * シナリオの内容や割当は各テスト自身が持つ。
 */

const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));

const specPath = fileURLToPath(
  new URL("../../../../../docs/ddd/12_テスト戦略.md", import.meta.url),
);

/**
 * `12_テスト戦略.md`「基準シナリオ」表からIDを抽出する。`rule-coverage.test.ts`の
 * `extractRuleIdsFromSpec` と同じ手法 — 凍結集合を手書きの決め打ちにせず、
 * 表そのものを正本にすることで、表への追記漏れが検査をすり抜けるのを防ぐ。
 * 退役した`SCN-BTL-022`は表自体に行が無いため、この抽出だけで自然に除外される。
 */
function extractBaselineScenarioIdsFromSpec(): string[] {
  const content = readFileSync(specPath, "utf-8");
  return [...content.matchAll(/^\| `(SCN-BTL-\d+)` \|/gm)].map((m) => m[1]!);
}

/**
 * 凍結する基準シナリオ集合。生成元は`12_テスト戦略.md`「基準シナリオ」表であり、
 * 新しいシナリオを追加するときは同じPRで表へ行を足せばこの集合へ自動反映される。
 */
const BASELINE_SCENARIO_IDS: readonly string[] = extractBaselineScenarioIdsFromSpec();

/**
 * 欠番のまま残すシナリオID。台帳（`retired-test-case-ids.ts`）から`SCN-BTL-*`分だけを
 * 導出する — 退役IDの正本は台帳の1か所とし、ここでの二重管理を避ける。
 */
const RETIRED_SCENARIO_IDS: readonly string[] = RETIRED_TEST_CASE_IDS.map(
  (entry) => entry.id,
).filter((id) => id.startsWith("SCN-BTL-"));

describe("baseline scenario coverage", () => {
  it("UT-SCN-COVERAGE-001: every baseline scenario exists as an executable test, and retired IDs stay gaps", () => {
    expect(BASELINE_SCENARIO_IDS).toHaveLength(27);

    // 実行対象のテストとして実在すること。`it.skip`/`todo`/条件付き無効化・
    // コメント内・文字列内は `collectTestCaseDefinitions` が除いている。
    const definitions = collectTestCaseDefinitions(apiSrcPath);
    const missing = BASELINE_SCENARIO_IDS.filter(
      (scenarioId) => (definitions.get(scenarioId) ?? []).length === 0,
    );
    expect(
      missing,
      `baseline scenarios that no longer have an executable test: ${JSON.stringify(missing)}`,
    ).toEqual([]);

    // 退役IDのテストが復活していないこと（欠番の実効性）。
    for (const scenarioId of RETIRED_SCENARIO_IDS) {
      expect(definitions.get(scenarioId) ?? []).toEqual([]);
    }
    // `collectTestCaseDefinitions` は src 全体を走査するため、coverage計測下では
    // 既定の5秒に収まらない（`UT-TRACEABILITY-005` と同じ理由・同じ猶予）。
  }, 30000);
});
