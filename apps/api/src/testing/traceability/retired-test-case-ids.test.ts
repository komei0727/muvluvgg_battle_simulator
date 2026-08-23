import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RETIRED_TEST_CASE_IDS } from "./retired-test-case-ids.js";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));

describe("retired test case id ledger", () => {
  it("UT-TRACEABILITY-011: no retired test case id has been reused by an executable test", () => {
    const definitions = collectTestCaseDefinitions(apiSrcPath);
    const revived = RETIRED_TEST_CASE_IDS.map((entry) => entry.id).filter(
      (id) => (definitions.get(id) ?? []).length > 0,
    );
    expect(
      revived,
      `retired test case ids reused by an executable test: ${JSON.stringify(revived)}`,
    ).toEqual([]);
  }, 30000);

  it("UT-TRACEABILITY-012: retired test case id ledger has no duplicate ids", () => {
    const ids = RETIRED_TEST_CASE_IDS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
