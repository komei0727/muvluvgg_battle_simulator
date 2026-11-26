import { describe, expect, it } from "vitest";
import { validateExpectedRevisions } from "./evaluation-runtime-info.js";

const ACTUAL = { catalogRevision: "cat-1", engineRevision: "eng-1" };

describe("validateExpectedRevisions", () => {
  it("UT-EVALRT-001: accepts omitted and matching expectations", () => {
    expect(validateExpectedRevisions({}, ACTUAL)).toEqual([]);
    expect(
      validateExpectedRevisions(
        { expectedCatalogRevision: "cat-1", expectedEngineRevision: "eng-1" },
        ACTUAL,
      ),
    ).toEqual([]);
  });

  it("UT-EVALRT-002: reports each mismatched revision on its own request path", () => {
    expect(
      validateExpectedRevisions(
        { expectedCatalogRevision: "cat-0", expectedEngineRevision: "eng-0" },
        ACTUAL,
      ),
    ).toEqual([
      {
        path: "expectedCatalogRevision",
        reason: 'does not match the server catalogRevision "cat-1", got "cat-0"',
      },
      {
        path: "expectedEngineRevision",
        reason: 'does not match the server engineRevision "eng-1", got "eng-0"',
      },
    ]);
  });
});
