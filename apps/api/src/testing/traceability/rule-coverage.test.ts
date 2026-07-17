import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULE_COVERAGE } from "./rule-coverage.js";

const specPath = fileURLToPath(
  new URL("../../../../../docs/ddd/07_戦闘ルール詳細.md", import.meta.url),
);

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
});
