import { collectTestCaseDefinitions } from "./test-case-definitions.js";

/**
 * REF-065／#610: `rule-coverage.ts`の`RULE_COVERAGE.testCaseIds`を、手書きの列挙ではなく
 * テスト側の宣言から導出するための収集器。
 *
 * テストは次のいずれかの方法でルールIDを宣言する（`12_テスト戦略.md`「ルールカバレッジ台帳」参照）。
 *
 * 1. **推定**: testCaseIdが`<LEVEL>-R-XXX-NN-連番`の形でルールIDそのものを名乗っている場合
 *    （例: `UT-R-NUM-01-001`は`R-NUM-01`）、追加の宣言なしにそのルールへ帰属する。
 * 2. **明示宣言**: `it()`/`test()`のタイトルで、testCaseIdトークンの直後に空白を挟んで
 *    `[R-XXX, R-YYY]`（カンマ区切り）を書く。これは推定を完全に上書きする正式なルール一覧になる
 *    （推定と明示の「加算」はしない）。IDからルールを推定できないテスト・複数ルールにまたがる
 *    テストは必ずこの形を使う。
 */

const RULE_ID_TOKEN_PATTERN = /R-[A-Z]+-\d+/;

/** 推定規則: testCaseId自身がルールIDを名乗っている場合、それを返す。 */
export function inferRuleIdFromTestCaseId(testCaseId: string): string | undefined {
  const match = /^(?:UT|IT|PROP)-(R-[A-Z]+-\d+)-\d+[a-z]?$/.exec(testCaseId);
  return match?.[1];
}

/**
 * 明示宣言規則: IDトークン直後のテキストが`\[...\]`で始まり、中身がカンマ区切りの
 * ルールIDトークンだけで構成されていれば、その一覧を返す。それ以外（ブラケットが無い、
 * 中身が不正）は`undefined`。
 */
export function extractExplicitRuleIds(trailingText: string): readonly string[] | undefined {
  const bracket = /^\s*\[([^[\]]+)\]/.exec(trailingText);
  if (bracket === undefined || bracket === null) {
    return undefined;
  }
  const tokens = bracket[1]!.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => !RULE_ID_TOKEN_PATTERN.test(token))) {
    return undefined;
  }
  return tokens;
}

/** 1件のtestCaseIdについて、宣言規則（明示 > 推定）を適用してルールID一覧を決める。 */
export function ruleIdsFor(testCaseId: string, trailingText: string): readonly string[] {
  const explicit = extractExplicitRuleIds(trailingText);
  if (explicit !== undefined) {
    return explicit;
  }
  const inferred = inferRuleIdFromTestCaseId(testCaseId);
  return inferred === undefined ? [] : [inferred];
}

/**
 * `directory`配下の全`.test.ts(x)`を走査し、ruleId → 対応するtestCaseIds（重複除去・昇順）
 * のMapを組み立てる。1つのtestCaseIdが複数の定義位置を持つ場合（採番衝突）でも、宣言規則が
 * 同じIDへ複数回同じルールを結び付けるだけなので、`RULE_COVERAGE`側の一意性検査
 * （`UT-TRACEABILITY-005`）を迂回しない。
 */
export function collectRuleDeclarations(directory: string): Map<string, string[]> {
  const definitions = collectTestCaseDefinitions(directory);
  const byRule = new Map<string, Set<string>>();
  for (const [testCaseId, occurrences] of definitions) {
    for (const occurrence of occurrences) {
      for (const ruleId of ruleIdsFor(testCaseId, occurrence.trailingText)) {
        const testCaseIds = byRule.get(ruleId) ?? new Set<string>();
        testCaseIds.add(testCaseId);
        byRule.set(ruleId, testCaseIds);
      }
    }
  }
  return new Map([...byRule].map(([ruleId, ids]) => [ruleId, [...ids].sort()]));
}
