import { describe, expect, it } from "vitest";
import {
  extractExplicitRuleIds,
  inferRuleIdFromTestCaseId,
  ruleIdsFor,
} from "./rule-declarations.js";

describe("extractExplicitRuleIds", () => {
  it("UT-RULEDECL-001: accepts a single well-formed rule ID bracket", () => {
    expect(extractExplicitRuleIds("[R-NUM-01]: does X")).toEqual(["R-NUM-01"]);
  });

  it("UT-RULEDECL-002: accepts multiple comma-separated rule IDs", () => {
    expect(extractExplicitRuleIds("[R-NUM-01, R-DMG-01]: does X")).toEqual([
      "R-NUM-01",
      "R-DMG-01",
    ]);
  });

  it("UT-RULEDECL-003: rejects a token with a garbage prefix (partial-match regression)", () => {
    // レビュー指摘: RULE_ID_TOKEN_PATTERNが部分一致だと"not-R-NUM-01"のような
    // トークンも有効な宣言として通ってしまう。
    expect(extractExplicitRuleIds("[not-R-NUM-01]: does X")).toBeUndefined();
  });

  it("UT-RULEDECL-004: rejects a token with a trailing suffix (partial-match regression)", () => {
    expect(extractExplicitRuleIds("[R-NUM-01-typo]: does X")).toBeUndefined();
  });

  it("UT-RULEDECL-005: rejects when any token in a multi-rule bracket is malformed", () => {
    expect(extractExplicitRuleIds("[R-NUM-01, not-a-rule]: does X")).toBeUndefined();
  });

  it("UT-RULEDECL-006: returns undefined when there is no bracket", () => {
    expect(extractExplicitRuleIds(": does X")).toBeUndefined();
  });
});

describe("inferRuleIdFromTestCaseId", () => {
  it("UT-RULEDECL-007: infers the rule ID a testCaseId embeds in its own subject segment", () => {
    expect(inferRuleIdFromTestCaseId("UT-R-NUM-01-001")).toBe("R-NUM-01");
  });

  it("UT-RULEDECL-008: returns undefined for a testCaseId that does not embed a rule ID", () => {
    expect(inferRuleIdFromTestCaseId("IT-UNIT-KARINA-DOWNER-007")).toBeUndefined();
  });
});

describe("ruleIdsFor", () => {
  it("UT-RULEDECL-009: an explicit bracket overrides inference rather than adding to it", () => {
    expect(ruleIdsFor("UT-R-ACT-01-001", "[R-STS-02]: does X")).toEqual(["R-STS-02"]);
  });

  it("UT-RULEDECL-010: a malformed explicit bracket falls back to inference, not silently to the malformed rule", () => {
    expect(ruleIdsFor("UT-R-NUM-01-001", "[not-R-NUM-01]: does X")).toEqual(["R-NUM-01"]);
  });

  it("UT-RULEDECL-011: neither inference nor an explicit bracket yields no rule association", () => {
    expect(ruleIdsFor("UT-MOD-027", ": does X")).toEqual([]);
  });
});
