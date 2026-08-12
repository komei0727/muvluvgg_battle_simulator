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

// 意図的に複数テストでの共有を許すID。`SCN-BTL-001`（1対1の基本戦闘）は
// `12_テスト戦略.md`の基準シナリオ1件を、決定性・lethal経路・use-case
// lifecycleの複数テストで分担して検証するため、1シナリオID＝複数実行テストを
// 正当な形として許容する。
const INTENTIONALLY_SHARED_TEST_CASE_IDS: ReadonlySet<string> = new Set(["SCN-BTL-001"]);

describe("Rule coverage ledger", () => {
  it("UT-TRACEABILITY-001: ledger contains exactly 134 rule IDs", () => {
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
    // REF-022（Issue #351）のEffect kind棚卸しでR-DMG-06（攻撃時追加ダメージ）を
    // 追加し117→118 — `APPLY_ATTACK_DAMAGE_BONUS`はR-SUB-02の除外条項だけが
    // 存在して加算そのもののRule定義が無かった。
    // REF-023（Issue #352）のCapability廃止でR-FRM-06（Capability preflight）を
    // 削除し118→117 — Capability宣言・runtimeStatus・preflightゲートごと廃止され、
    // `07_戦闘ルール詳細.md`のRule定義も同時に削除した。
    // TEX-001（Issue #402、2026-08-10）の戦術演習設計でR-TEX-01〜10を新設し
    // 117→127 — スコアアタックモード（ブレイク・復活・スコア集計）の新領域で、
    // 実装前の設計時新設のためtestCaseIdsは空（`17_残作業対応表.json`の
    // `ruleAssignments`でTEX-001が完了責任を持つ）。
    // ENH-001（Issue #409、2026-08-11）の基本ステータス強化設計でR-ENH-01〜06を新設し
    // 127→133 — 学園レベル・タイプ装備・モジュール・ギアカスタム・レベル増加で
    // 強化後基本ステータスを算出する新領域で、ENH-006（Issue #415）が6件すべてを
    // 完了計上した（総数は変わらない）。
    // TEX-010（Issue #447、2026-08-12）で演習ユニットのカテゴリと編成プールの
    // R-TEX-11を新設し133→134 — 設計と同じPRで実装・テスト登録まで完了した。
    // 実装中に新しいRuleを発見した場合はここと`17_残作業対応表.json`の
    // `current.rules`を同じPRで更新する（`baseline`は履歴として変更しない）。
    expect(RULE_COVERAGE).toHaveLength(134);
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

  it("UT-TRACEABILITY-005: every testCaseId maps to exactly one executable test", () => {
    // 台帳が列挙する正例IDが、リポジトリ内に実在する「実行対象の」テスト
    // （`it.skip`/`todo`/条件付き無効化・コメント内・文字列内を除く）に
    // ちょうど1件対応することを機械照合する。IDのリネーム・削除で台帳が実体を
    // 失う「見せかけのカバレッジ」と、同一IDを複数の別テストが使用する衝突
    // （どのテストが証跡か特定できない曖昧なトレーサビリティ）の双方を防ぐ。
    // 衝突検査は台帳掲載IDに限らず、収集された全IDへ適用する — 台帳外で
    // 生まれた重複が、後から台帳・Capability検証へ持ち込まれるのを防ぐ。
    //
    // `remaining-work.test.ts`の`IT-TRACE-003`重複はパーサ検証用のテンプレート
    // リテラル内ソース（実行されないフィクスチャ）であり、そもそも収集され
    // ないため許可リスト登録は不要（UT-PLAN-001-007がその挙動自体を検証する）。
    const definitions = collectTestCaseDefinitions(apiSrcPath);
    const violations: string[] = [];
    for (const coverage of RULE_COVERAGE) {
      for (const testCaseId of coverage.testCaseIds) {
        const count = (definitions.get(testCaseId) ?? []).length;
        const required = INTENTIONALLY_SHARED_TEST_CASE_IDS.has(testCaseId)
          ? count >= 1
          : count === 1;
        if (!required) {
          violations.push(`${coverage.ruleId} -> ${testCaseId} (${count} definitions)`);
        }
      }
    }
    const ambiguous = [...definitions.entries()]
      .filter(([id, defs]) => defs.length > 1 && !INTENTIONALLY_SHARED_TEST_CASE_IDS.has(id))
      .map(([id, defs]) => `${id}: ${defs.map((d) => d.file.replace(apiSrcPath, "")).join(", ")}`)
      .sort();
    expect(
      violations,
      `ledger testCaseIds without exactly one executable test: ${JSON.stringify(violations)}`,
    ).toEqual([]);
    expect(
      ambiguous,
      `testCaseIds shared by multiple executable tests: ${JSON.stringify(ambiguous)}`,
    ).toEqual([]);
  }, 30000);
});
