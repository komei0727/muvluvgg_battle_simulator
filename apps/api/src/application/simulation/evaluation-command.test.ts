import { describe, expect, it } from "vitest";
import {
  prefixViolationPaths,
  validateEvaluationRequestShape,
  type EvaluationRequestShape,
} from "./evaluation-command.js";

const LIMITS = { maxCases: 3, maxTotalRuns: 5 };

function shape(overrides: Partial<EvaluationRequestShape> = {}): EvaluationRequestShape {
  return {
    seed: "seed",
    cases: [{ caseId: "a", runIndices: [0, 1] }],
    ...overrides,
  };
}

describe("validateEvaluationRequestShape", () => {
  it("UT-EVALREQ-001: accepts non-contiguous run indices up to the unsigned 32-bit maximum", () => {
    expect(
      validateEvaluationRequestShape(
        shape({ cases: [{ caseId: "a", runIndices: [0, 42, 0xffffffff] }] }),
        LIMITS,
      ),
    ).toEqual([]);
  });

  it("UT-EVALREQ-002: rejects a blank seed", () => {
    expect(validateEvaluationRequestShape(shape({ seed: "  " }), LIMITS)).toEqual([
      { path: "seed", reason: "must not be blank" },
    ]);
  });

  it("UT-EVALREQ-003: rejects an empty case list and more cases than the limit", () => {
    expect(validateEvaluationRequestShape(shape({ cases: [] }), LIMITS)).toEqual([
      { path: "cases", reason: "must contain at least 1 case" },
    ]);
    const tooMany = ["a", "b", "c", "d"].map((caseId) => ({ caseId, runIndices: [0] }));
    expect(validateEvaluationRequestShape(shape({ cases: tooMany }), LIMITS)).toEqual([
      { path: "cases", reason: "must not contain more than 3 cases, got 4" },
    ]);
  });

  it("UT-EVALREQ-004: rejects blank and duplicate case ids with the index of the offending case", () => {
    expect(
      validateEvaluationRequestShape(
        shape({
          cases: [
            { caseId: "a", runIndices: [0] },
            { caseId: " ", runIndices: [0] },
            { caseId: "a", runIndices: [0] },
          ],
        }),
        LIMITS,
      ),
    ).toEqual([
      { path: "cases[1].caseId", reason: "must not be blank" },
      { path: "cases[2].caseId", reason: 'duplicates the caseId of cases[0]: "a"' },
    ]);
  });

  it("UT-EVALREQ-005: rejects an empty, out-of-range, fractional or duplicate run index", () => {
    expect(
      validateEvaluationRequestShape(
        shape({
          cases: [
            { caseId: "a", runIndices: [] },
            { caseId: "b", runIndices: [-1, 0.5, 2 ** 32, 3, 3] },
          ],
        }),
        { maxCases: 3, maxTotalRuns: 10 },
      ),
    ).toEqual([
      { path: "cases[0].runIndices", reason: "must contain at least 1 run index" },
      {
        path: "cases[1].runIndices[0]",
        reason: "must be an integer between 0 and 4294967295, got -1",
      },
      {
        path: "cases[1].runIndices[1]",
        reason: "must be an integer between 0 and 4294967295, got 0.5",
      },
      {
        path: "cases[1].runIndices[2]",
        reason: "must be an integer between 0 and 4294967295, got 4294967296",
      },
      { path: "cases[1].runIndices[4]", reason: "duplicates runIndices[3]: 3" },
    ]);
  });

  it("UT-EVALREQ-006: rejects a request whose summed run indices exceed the total run limit", () => {
    expect(
      validateEvaluationRequestShape(
        shape({
          cases: [
            { caseId: "a", runIndices: [0, 1, 2] },
            { caseId: "b", runIndices: [0, 1, 2] },
          ],
        }),
        LIMITS,
      ),
    ).toEqual([
      {
        path: "cases",
        reason: "the summed runIndices of all cases must not exceed 5 runs, got 6",
      },
    ]);
  });

  it("UT-EVALREQ-007: rejects blank expected revisions", () => {
    expect(
      validateEvaluationRequestShape(
        shape({ expectedCatalogRevision: "", expectedEngineRevision: " " }),
        LIMITS,
      ),
    ).toEqual([
      { path: "expectedCatalogRevision", reason: "must not be blank" },
      { path: "expectedEngineRevision", reason: "must not be blank" },
    ]);
  });
});

describe("prefixViolationPaths", () => {
  it("UT-EVALREQ-008: places a single-run violation under the case that produced it", () => {
    expect(
      prefixViolationPaths(
        [{ path: "allyFormation.slots[0].unitDefinitionId", reason: "x" }, { reason: "y" }],
        "cases[2]",
      ),
    ).toEqual([
      { path: "cases[2].allyFormation.slots[0].unitDefinitionId", reason: "x" },
      { path: "cases[2]", reason: "y" },
    ]);
  });
});
