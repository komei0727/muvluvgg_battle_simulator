import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EFFECT_ACTION_KINDS } from "../../domain/catalog/definitions/effect-action-definition.js";
import { EFFECT_KIND_COVERAGE } from "./effect-kind-coverage.js";
import { RULE_COVERAGE } from "./rule-coverage.js";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));

const ruleCoverageById = new Map(RULE_COVERAGE.map((coverage) => [coverage.ruleId, coverage]));

describe("Effect kind coverage ledger", () => {
  it("UT-TRACEABILITY-006: ledger keys match EFFECT_ACTION_KINDS exactly", () => {
    // `Record<EffectActionKind, …>`の型で追加漏れ・削除余剰はコンパイルエラーに
    // なるが、`as`での型強制や部分適用をすり抜けた場合に備えて実行時にも照合する。
    const ledgerKinds = Object.keys(EFFECT_KIND_COVERAGE).sort();
    const declaredKinds = [...EFFECT_ACTION_KINDS].sort();
    expect(ledgerKinds).toEqual(declaredKinds);
  });

  it("UT-TRACEABILITY-007: every kind maps to at least one rule that exists in the rule ledger", () => {
    // ruleIdの実在は`RULE_COVERAGE`への包含で検証する。`RULE_COVERAGE`自体は
    // UT-TRACEABILITY-002が`07_戦闘ルール詳細.md`と完全一致することを保証して
    // いるため、ここを通れば設計書の実在ルールへ連鎖して辿り着ける。
    const violations: string[] = [];
    for (const kind of EFFECT_ACTION_KINDS) {
      const { ruleIds } = EFFECT_KIND_COVERAGE[kind];
      if (ruleIds.length === 0) {
        violations.push(`${kind}: no ruleIds`);
      }
      if (new Set(ruleIds).size !== ruleIds.length) {
        violations.push(`${kind}: duplicate ruleIds`);
      }
      for (const ruleId of ruleIds) {
        if (!ruleCoverageById.has(ruleId)) {
          violations.push(`${kind}: unknown rule "${ruleId}"`);
        }
      }
    }
    expect(violations, `kinds without valid rules: ${JSON.stringify(violations)}`).toEqual([]);
  });

  it(
    "UT-TRACEABILITY-008: every kind maps to test cases that each resolve to exactly one executable test",
    { timeout: 30000 },
    () => {
      const definitions = collectTestCaseDefinitions(apiSrcPath);
      const violations: string[] = [];
      for (const kind of EFFECT_ACTION_KINDS) {
        const { testCaseIds } = EFFECT_KIND_COVERAGE[kind];
        if (testCaseIds.length === 0) {
          violations.push(`${kind}: no testCaseIds`);
        }
        if (new Set(testCaseIds).size !== testCaseIds.length) {
          violations.push(`${kind}: duplicate testCaseIds`);
        }
        for (const testCaseId of testCaseIds) {
          const count = (definitions.get(testCaseId) ?? []).length;
          if (count !== 1) {
            violations.push(`${kind} -> ${testCaseId} (${count} definitions)`);
          }
        }
      }
      expect(
        violations,
        `kinds without exactly-one executable test evidence: ${JSON.stringify(violations)}`,
      ).toEqual([]);
    },
  );

  it("UT-TRACEABILITY-009: every kind's test cases are registered under one of its rules", () => {
    // 「kind→ルール→テスト」の三者が閉じていることの検査。ルール台帳に載って
    // いないテストをkindの証跡として挙げると、そのテストがどのルールの振る舞いを
    // 保証しているのか追跡できなくなるため、kindのtestCaseIdsは必ずそのkindの
    // ruleIdsのいずれかの`RULE_COVERAGE.testCaseIds`に含まれることを要求する。
    const violations: string[] = [];
    for (const kind of EFFECT_ACTION_KINDS) {
      const { ruleIds, testCaseIds } = EFFECT_KIND_COVERAGE[kind];
      const registered = new Set(
        ruleIds.flatMap((ruleId) => ruleCoverageById.get(ruleId)?.testCaseIds ?? []),
      );
      for (const testCaseId of testCaseIds) {
        if (!registered.has(testCaseId)) {
          violations.push(
            `${kind} -> ${testCaseId} is not registered under ${JSON.stringify(ruleIds)}`,
          );
        }
      }
    }
    expect(
      violations,
      `test cases outside the kind's rule coverage: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});
