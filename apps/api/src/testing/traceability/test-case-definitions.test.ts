import { describe, expect, it } from "vitest";
import { collectTestCaseDefinitionsFromSource } from "./test-case-definitions.js";

/**
 * `collectTestCaseDefinitionsFromSource` は「実行対象のテストだけをテストケースIDの
 * 実在根拠として数える」パーサであり、トレーサビリティ検査（`UT-TRACEABILITY-005` や
 * production ID 網羅監査）の信頼性はこのパーサの取りこぼし・拾いすぎに直結する。
 * ここでは skip/todo・条件付き無効化・到達不能・シャドーイングなど、根拠として
 * 数えてはならない形を網羅的に固定する。
 */
describe("test case definition collector", () => {
  it("UT-TESTDEFS-001: counts only test titles and preserves duplicate definitions", () => {
    const definitions = collectTestCaseDefinitionsFromSource(
      `
        import { describe, it, suite, test } from "vitest";
        // IT-TRACE-001: a comment is not evidence
        const note = "IT-TRACE-002: an arbitrary string is not evidence";
        it("IT-TRACE-003: first definition", () => {});
        it.each([[1]])("IT-TRACE-003: duplicate definition", () => {});
        it.skip("IT-TRACE-004: skipped test is not evidence", () => {});
        test.todo("IT-TRACE-005: todo test is not evidence");
        it.skipIf(true)("IT-TRACE-006: conditionally skipped test is not evidence", () => {});
        test.runIf(false)("IT-TRACE-007: conditionally disabled test is not evidence", () => {});
        describe.skip("disabled suite", () => {
          it("IT-TRACE-008: test in a skipped suite is not evidence", () => {});
        });
        if (false) {
          it("IT-TRACE-009: conditionally registered test is not evidence", () => {});
        }
        process.env.RUN_TRACE_TEST &&
          test("IT-TRACE-010: logical-condition test is not evidence", () => {});
        function registerTestsLater() {
          it("IT-TRACE-011: test in an uncalled function is not evidence", () => {});
        }
        suite.skip("disabled suite alias", () => {
          test("IT-TRACE-012: test in a skipped suite alias is not evidence", () => {});
        });
        it.each([])("IT-TRACE-013: empty parameter table is not evidence", () => {});
        describe.each([])("empty parameterized suite", () => {
          it("IT-TRACE-014: test in an empty parameterized suite is not evidence", () => {});
        });
        describe("shadowed Vitest binding", () => {
          const it = (_title: string, _callback: () => void) => {};
          it("IT-TRACE-015: a shadowed it binding is not evidence", () => {});
        });
        const dynamicCases = [[1]];
        test.each(dynamicCases)("IT-TRACE-016: a dynamic parameter table is not evidence", () => {});
        it("IT-TRACE-020: options-based skipped test is not evidence", { skip: true }, () => {});
        test("IT-TRACE-021: options-based todo test is not evidence", { todo: true }, () => {});
        it("IT-TRACE-022: a test without a callback is not evidence");
        describe("options-based skipped suite", { skip: true }, () => {
          it("IT-TRACE-023: test in options-based skipped suite is not evidence", () => {});
        });
        it.each([...[]])("IT-TRACE-024: empty spread parameter table is not evidence", () => {});
        it("IT-TRACE-026: computed todo option is not evidence", { ["todo"]: true }, () => {});
        it("IT-TRACE-027: accessor skip option is not evidence", { get skip() { return true; } }, () => {});
        const skipOption = "skip";
        it("IT-TRACE-028: dynamic computed option is not evidence", { [skipOption]: true }, () => {});
        try {
          throw new Error();
          it("IT-TRACE-029: a test after an unconditional throw inside a try block is not evidence", () => {});
        } catch {
          // swallow
        }
        try {
          it("IT-TRACE-030: any test inside a try block is not evidence, even without a preceding throw", () => {});
        } catch {
          // swallow
        }
        try {
          if (true) {
            throw new Error();
          }
          it("IT-TRACE-031: a test after an always-true conditional throw inside a try block is not evidence", () => {});
        } catch {
          // swallow
        }
      `,
      "traceability.test.ts",
    );

    expect(definitions.map(([id]) => id)).toEqual(["IT-TRACE-003", "IT-TRACE-003"]);

    // An uncaught throw in a bare block halts evaluation of everything that
    // follows it in the same (or an enclosing) scope, not just the rest of
    // that block — so this case must be isolated instead of appended to the
    // source above, or it would silently swallow every later assertion.
    const unreachableBlockDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { it } from "vitest";
        {
          throw new Error();
          it("IT-TRACE-032: a test after an unconditional throw in a bare block is not evidence", () => {});
        }
      `,
      "unreachable-block.test.ts",
    );
    expect(unreachableBlockDefinitions).toEqual([]);

    const cascadingUnreachableDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { it } from "vitest";
        {
          it("IT-TRACE-033: a reachable test in a bare block before a throw is evidence", () => {});
          throw new Error();
        }
        it("IT-TRACE-034: a test after a block that unconditionally throws is not evidence", () => {});
      `,
      "cascading-unreachable.test.ts",
    );
    expect(cascadingUnreachableDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-033"]);

    const suiteGuardClauseDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { describe, it } from "vitest";
        describe("suite with an unconditional guard clause", () => {
          if (true) return;
          it("IT-TRACE-035: a test after an unconditional guard-clause return is not evidence", () => {});
        });
        describe("suite with an environment-dependent guard clause", () => {
          if (process.env.SKIP_SUITE) return;
          it("IT-TRACE-036: a test after a conditional guard-clause return is not evidence", () => {});
        });
        describe("suite with a non-exiting if statement", () => {
          if (someCondition) {
            doSomething();
          }
          it("IT-TRACE-037: a test after a non-exiting if statement is also not evidence, since reachability through an arbitrary condition can't be proven either way", () => {});
        });
      `,
      "suite-guard-clause.test.ts",
    );
    expect(suiteGuardClauseDefinitions).toEqual([]);

    // Rather than enumerating every syntax kind that can skip past later
    // statements (if, switch, while, for, try/finally, labeled statements,
    // ...), only a small allowlist of statement kinds that are guaranteed to
    // fall through unconditionally is trusted; anything else preceding a
    // test call is rejected regardless of what it is.
    const precedingControlFlowDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { describe, it } from "vitest";
        describe("suite with a switch guard clause", () => {
          switch (process.env.MODE) {
            case "skip":
              return;
          }
          it("IT-TRACE-038: a test after a switch statement is not evidence", () => {});
        });
        describe("suite with a while loop", () => {
          while (process.env.RETRY) {
            break;
          }
          it("IT-TRACE-039: a test after a while statement is not evidence", () => {});
        });
        describe("suite with a for loop", () => {
          for (let i = 0; i < 1; i++) {
            continue;
          }
          it("IT-TRACE-040: a test after a for statement is not evidence", () => {});
        });
        describe("suite with a try/finally statement", () => {
          try {
            setup();
          } finally {
            teardown();
          }
          it("IT-TRACE-041: a test after a try/finally statement is not evidence", () => {});
        });
        describe("suite with a labeled statement", () => {
          outer: for (let i = 0; i < 1; i++) {
            break outer;
          }
          it("IT-TRACE-042: a test after a labeled statement is not evidence", () => {});
        });
        describe("suite with only control-flow-safe statements", () => {
          const value = 1;
          setup(value);
          it("IT-TRACE-043: a test after only control-flow-safe statements is evidence", () => {});
        });
      `,
      "preceding-control-flow.test.ts",
    );
    expect(precedingControlFlowDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-043"]);

    const shadowedDefinitions = collectTestCaseDefinitionsFromSource(
      `
        const test = (_title: string, _callback: () => void) => {};
        const it = test;
        test("IT-TRACE-017: a local test function is not evidence", () => {});
        it("IT-TRACE-018: a local it function is not evidence", () => {});
      `,
      "shadowed.test.ts",
    );
    expect(shadowedDefinitions).toEqual([]);

    const aliasedDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { it as vitestIt } from "vitest";
        vitestIt("IT-TRACE-019: an imported Vitest alias is evidence", () => {});
      `,
      "aliased.test.ts",
    );
    expect(aliasedDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-019"]);

    const staticOptionsDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { describe, it } from "vitest";
        describe("static executing options", { skip: false, todo: false }, () => {
          it("IT-TRACE-025: explicit executing options are evidence", { skip: false }, () => {});
        });
      `,
      "static-options.test.ts",
    );
    expect(staticOptionsDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-025"]);
  });
});
