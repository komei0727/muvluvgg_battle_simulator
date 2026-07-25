import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULE_COVERAGE } from "./rule-coverage.js";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

const specPath = fileURLToPath(
  new URL("../../../../../docs/ddd/07_戦闘ルール詳細.md", import.meta.url),
);

const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));

function extractRuleIdsFromSpec(): string[] {
  const content = readFileSync(specPath, "utf-8");
  return [...content.matchAll(/^### (R-[A-Z]+-\d+)/gm)]
    .map((m) => m[1])
    .filter((id): id is string => id !== undefined);
}

describe("Rule coverage ledger", () => {
  it("UT-TRACEABILITY-001: ledger contains exactly 109 rule IDs", () => {
    expect(RULE_COVERAGE).toHaveLength(109);
  });

  it("UT-TRACEABILITY-002: ledger rule IDs match spec exactly", () => {
    const specIds = extractRuleIdsFromSpec().sort();
    const ledgerIds = RULE_COVERAGE.map((r) => r.ruleId).sort();
    expect(ledgerIds).toEqual(specIds);
  });

  it("UT-TRACEABILITY-003: ledger has no duplicate rule IDs", () => {
    const ledgerIds = RULE_COVERAGE.map((r) => r.ruleId);
    const unique = new Set(ledgerIds);
    expect(unique.size).toBe(ledgerIds.length);
  });

  it("UT-TRACEABILITY-004: no rule lists the same testCaseId twice", () => {
    // 複数ルールを確認するテストが複数のルールから参照されるのは戦略上正当なので
    // （§トレーサビリティ「複数ルールを確認するシナリオは関連する全ルールIDを持つ」）、
    // ここではルールを跨いだ共有は許容し、同一ルール内での重複だけを誤りとして弾く。
    const duplicated = RULE_COVERAGE.filter(
      (coverage) => new Set(coverage.testCaseIds).size !== coverage.testCaseIds.length,
    ).map((coverage) => coverage.ruleId);
    expect(
      duplicated,
      `rules listing a duplicate testCaseId: ${JSON.stringify(duplicated)}`,
    ).toEqual([]);
  });

  it("UT-TRACEABILITY-005: every claimed testCaseId is backed by an executable test", () => {
    // 台帳が列挙する正例IDが、リポジトリ内に実在する「実行対象の」テスト
    // （`it.skip`/`todo`/条件付き無効化・コメント内・文字列内を除く）に
    // 最低1件対応することを機械照合する。IDのリネーム・削除で台帳が実体を
    // 失う「見せかけのカバレッジ」を防ぐ。
    //
    // 注: 同一IDを複数の別テストが使用する衝突（曖昧なトレーサビリティ）は
    // 既存テスト群に約42件残っており、採番の一括修正は別フォローアップで扱う。
    // ここでは phantom ID（実体ゼロ）の検出に集中し、≥1件を合格条件とする。
    const definitions = collectTestCaseDefinitions(apiSrcPath);
    const missing: string[] = [];
    for (const coverage of RULE_COVERAGE) {
      for (const testCaseId of coverage.testCaseIds) {
        if ((definitions.get(testCaseId) ?? []).length === 0) {
          missing.push(`${coverage.ruleId} -> ${testCaseId}`);
        }
      }
    }
    expect(
      missing,
      `ledger testCaseIds with no executable test: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  }, 30000);
});
