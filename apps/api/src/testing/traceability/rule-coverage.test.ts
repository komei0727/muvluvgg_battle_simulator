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
  it("UT-TRACEABILITY-001: ledger contains exactly 117 rule IDs", () => {
    // M7-005-HEAL-LINK（Issue #229）でR-HEAL-04（回復リンク）を追加し109→110。
    // M7-018（Issue #272）でR-HIT-04（Nヒット回避）・R-HIT-05（必中付与）を
    // 追加し110→112 — どちらも`07_戦闘ルール詳細.md`にRule定義自体が無いまま
    // production定義（`HIT_EVASION`/`GUARANTEED_HIT`）だけが存在していた。
    // M7-014（Issue #268）でR-EFF-12（再付与時の動的期間）を追加し112→113 —
    // 既存効果の残存に応じて付与するdurationを変える契約は、R-EFF-01の期間単位でも
    // R-STS-02の再付与規則でも規定されていなかった。
    // DMG-003A（Issue #295）でR-CRT-03（会心保証・会心不可）を追加し113→114 —
    // R-HIT-04/05と同じく、production定義（`CRITICAL_GUARANTEE`/
    // `CRITICAL_PREVENTION`）だけが存在してRule定義が無かった最後の1件。
    // DMG-009（Issue #193）でR-CFS-01（混乱の対象振り替え）・R-CFS-02（混乱時の
    // ダメージ）・R-DTH-01（幻惑）を追加し114→117 — 同じく`SKL_OLGA_VETERAN_EX`／
    // `SKL_TATIANA_SAGE_AS1`のraw原文だけが存在してRule定義が無かった。
    // 実装中に新しいRuleを発見した場合はここと`17_残作業対応表.json`の
    // `current.rules`を同じPRで更新する（`baseline`は履歴として変更しない）。
    expect(RULE_COVERAGE).toHaveLength(117);
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
