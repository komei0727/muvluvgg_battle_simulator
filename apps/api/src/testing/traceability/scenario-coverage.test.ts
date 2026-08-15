import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

/**
 * 基準シナリオ（`SCN-BTL-*`）の実在監視。基準シナリオの多くはルールカバレッジ台帳
 * （`rule-coverage.ts`）に載らないため、この監視がないとシナリオテストの黙った削除
 * （ファイルごと消える・`it.skip` 化する）を検出する仕組みがなくなる。
 * ここで凍結した集合が実行対象のテストとして実在し続けることだけを検証し、
 * シナリオの内容や割当は各テスト自身が持つ。
 */

const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 凍結する基準シナリオ集合。`SCN-BTL-001`〜`023` のうち退役分を除く22件。
 * 新しいシナリオを追加するときは末尾へ番号を足し、この集合へ同じ PR で追記する。
 */
const BASELINE_SCENARIO_IDS: readonly string[] = Array.from(
  { length: 23 },
  (_unused, index) => `SCN-BTL-${String(index + 1).padStart(3, "0")}`,
).filter((scenarioId) => scenarioId !== "SCN-BTL-022");

/**
 * 欠番のまま残すシナリオID。`SCN-BTL-022`（未実装Capabilityの拒否）は
 * Capability概念ごと廃止された（Issue #352）ため、検証対象そのものが存在しない。
 * 番号の再利用は過去の証跡との衝突を生むので、復活も再割当もしない。
 */
const RETIRED_SCENARIO_IDS: readonly string[] = ["SCN-BTL-022"];

describe("baseline scenario coverage", () => {
  it("UT-SCN-COVERAGE-001: every baseline scenario exists as an executable test, and retired IDs stay gaps", () => {
    expect(BASELINE_SCENARIO_IDS).toHaveLength(22);

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
