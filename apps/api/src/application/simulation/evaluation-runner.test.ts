import { describe, expect, it } from "vitest";
import { ApplicationError } from "../contracts/application-error.js";
import { runEvaluationSchedule } from "./evaluation-runner.js";
import { ManualClock } from "../../testing/clock/manual-clock.js";

interface Plan {
  readonly caseId: string;
  readonly runIndices: readonly number[];
}

const FAR_DEADLINE = Number.MAX_SAFE_INTEGER;

describe("runEvaluationSchedule", () => {
  it("UT-EVALRUN-001: runs every requested trial and returns them by caseId and runIndex", () => {
    const cases: Plan[] = [
      { caseId: "a", runIndices: [0, 1, 42] },
      { caseId: "b", runIndices: [7] },
    ];

    const outcome = runEvaluationSchedule(cases, {
      clock: new ManualClock(0),
      deadlineEpochMs: FAR_DEADLINE,
      runTrial: (plan, runIndex) => `${plan.caseId}:${runIndex}`,
    });

    expect(outcome).toEqual({
      requestedRuns: 4,
      completedRuns: 4,
      partial: false,
      cases: [
        {
          caseId: "a",
          runs: [
            { runIndex: 0, result: "a:0" },
            { runIndex: 1, result: "a:1" },
            { runIndex: 42, result: "a:42" },
          ],
          incompleteRunIndices: [],
        },
        { caseId: "b", runs: [{ runIndex: 7, result: "b:7" }], incompleteRunIndices: [] },
      ],
    });
  });

  it("UT-EVALRUN-002: advances cases round-robin instead of exhausting one case first", () => {
    const order: string[] = [];
    runEvaluationSchedule(
      [
        { caseId: "a", runIndices: [0, 1, 2] },
        { caseId: "b", runIndices: [5] },
        { caseId: "c", runIndices: [8, 9] },
      ],
      {
        clock: new ManualClock(0),
        deadlineEpochMs: FAR_DEADLINE,
        runTrial: (plan, runIndex) => order.push(`${plan.caseId}:${runIndex}`),
      },
    );

    expect(order).toEqual(["a:0", "b:5", "c:8", "a:1", "c:9", "a:2"]);
  });

  it("UT-EVALRUN-003: stops at the deadline and reports every unstarted trial as incomplete without renumbering", () => {
    const clock = new ManualClock(0);
    const outcome = runEvaluationSchedule(
      [
        { caseId: "a", runIndices: [0, 3, 6] },
        { caseId: "b", runIndices: [1, 4] },
      ],
      {
        clock,
        deadlineEpochMs: 2,
        runTrial: (plan, runIndex) => {
          clock.advance(1);
          return `${plan.caseId}:${runIndex}`;
        },
      },
    );

    expect(outcome).toEqual({
      requestedRuns: 5,
      completedRuns: 2,
      partial: true,
      cases: [
        { caseId: "a", runs: [{ runIndex: 0, result: "a:0" }], incompleteRunIndices: [3, 6] },
        { caseId: "b", runs: [{ runIndex: 1, result: "b:1" }], incompleteRunIndices: [4] },
      ],
    });
  });

  it("UT-EVALRUN-004: a trial that hits EXECUTION_TIMEOUT is incomplete, not a recorded result", () => {
    const outcome = runEvaluationSchedule(
      [
        { caseId: "a", runIndices: [0, 1] },
        { caseId: "b", runIndices: [2] },
      ],
      {
        clock: new ManualClock(0),
        deadlineEpochMs: FAR_DEADLINE,
        runTrial: (plan, runIndex) => {
          if (plan.caseId === "b") {
            throw new ApplicationError("EXECUTION_TIMEOUT", [{ reason: "deadline" }]);
          }
          return runIndex;
        },
      },
    );

    expect(outcome.partial).toBe(true);
    expect(outcome.completedRuns).toBe(1);
    expect(outcome.cases).toEqual([
      { caseId: "a", runs: [{ runIndex: 0, result: 0 }], incompleteRunIndices: [1] },
      { caseId: "b", runs: [], incompleteRunIndices: [2] },
    ]);
  });

  it("UT-EVALRUN-005: a deadline that has already passed still identifies every requested trial", () => {
    const outcome = runEvaluationSchedule([{ caseId: "a", runIndices: [9, 3] }], {
      clock: new ManualClock(10),
      deadlineEpochMs: 10,
      runTrial: () => {
        throw new Error("must not run");
      },
    });

    expect(outcome).toEqual({
      requestedRuns: 2,
      completedRuns: 0,
      partial: true,
      cases: [{ caseId: "a", runs: [], incompleteRunIndices: [9, 3] }],
    });
  });

  it("UT-EVALRUN-006: errors other than EXECUTION_TIMEOUT propagate instead of becoming results", () => {
    const failure = new ApplicationError("EXECUTION_LIMIT_EXCEEDED", [{ reason: "guard" }]);

    expect(() =>
      runEvaluationSchedule([{ caseId: "a", runIndices: [0] }], {
        clock: new ManualClock(0),
        deadlineEpochMs: FAR_DEADLINE,
        runTrial: () => {
          throw failure;
        },
      }),
    ).toThrow(failure);
  });
});
