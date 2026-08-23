import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTestCaseDefinitions,
  collectTestCaseDefinitionsFromSource,
} from "./test-case-definitions.js";

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

    // `it.each(識別子)`は、同一ファイル内の`const`宣言（`TypeChecker`のシンボル解決で
    // 辿る）が配列リテラルへ解決できるときだけテーブル行のIDまで収集し、それ以外は
    // タイトル文字列のIDだけを収集対象とする（テーブルの実行有無を過大に断定しない）。
    const resolvedIdentifierTableDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { test } from "vitest";
        const dynamicCases = [[1]];
        test.each(dynamicCases)("IT-TRACE-016: a same-file const array table is evidence", () => {});
      `,
      "resolved-identifier-table.test.ts",
    );
    expect(resolvedIdentifierTableDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-016"]);

    const resolvedIdentifierTableCellDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { test } from "vitest";
        const CASES = [["IT-TRACE-044: first row"], ["IT-TRACE-045: second row"]];
        test.each(CASES)("%s", (title) => {});
      `,
      "resolved-identifier-table-cell.test.ts",
    );
    expect(resolvedIdentifierTableCellDefinitions.map(([id]) => id)).toEqual([
      "IT-TRACE-044",
      "IT-TRACE-045",
    ]);

    const letDeclaredTableDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { test } from "vitest";
        let mutableCases = [["IT-TRACE-046: a let-bound table row is not evidence"]];
        test.each(mutableCases)("IT-TRACE-047: a let-bound table falls back to the title", () => {});
      `,
      "let-declared-table.test.ts",
    );
    expect(letDeclaredTableDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-047"]);

    const computedTableDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { test } from "vitest";
        function loadCases() { return [[1]]; }
        const COMPUTED_CASES = loadCases();
        test.each(COMPUTED_CASES)("IT-TRACE-048: a computed const table falls back to the title", () => {});
      `,
      "computed-table.test.ts",
    );
    expect(computedTableDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-048"]);

    const emptyResolvedTableDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { test } from "vitest";
        const EMPTY_CASES = [];
        test.each(EMPTY_CASES)("IT-TRACE-049: an empty same-file const table is not evidence", () => {});
      `,
      "empty-resolved-table.test.ts",
    );
    expect(emptyResolvedTableDefinitions).toEqual([]);

    const spreadResolvedTableDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { test } from "vitest";
        const BASE_CASES = [[1]];
        const SPREAD_CASES = [...BASE_CASES, [2]];
        test.each(SPREAD_CASES)("IT-TRACE-050: a same-file const table with a spread element is not evidence", () => {});
      `,
      "spread-resolved-table.test.ts",
    );
    expect(spreadResolvedTableDefinitions).toEqual([]);

    // `moduleSpecificDirs`（`module-boundary.test.ts`）のように、describeコールバック
    // 内で宣言されたブロックスコープのconstを複数の兄弟`it.each`が参照する形も、
    // シンボル解決（宣言箇所ではなく参照箇所のスコープ）で正しく辿れる。
    const nestedScopeTableDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { describe, it } from "vitest";
        describe("module-specific rules", () => {
          const dirs = ["a", "b"];
          it.each(dirs)("IT-TRACE-051: %s cannot import from application", () => {});
          it.each(dirs)("IT-TRACE-052: %s cannot import Node.js built-ins", () => {});
        });
      `,
      "nested-scope-table.test.ts",
    );
    expect(nestedScopeTableDefinitions.map(([id]) => id)).toEqual(["IT-TRACE-051", "IT-TRACE-052"]);

    // `INT`（Worker・Bootstrap統合テスト）・`APP`（アプリケーション層契約テスト）は
    // 一意性検査の外に居ると同じIDを別のテストが名乗っても誰も気づかない
    // （`INT-WORKER-006`が実際に2回使われていた）ため、`API`と同様に検査対象へ含める。
    const intAppPatternDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { it } from "vitest";
        it("INT-TRACE-001: an INT-prefixed id is evidence", () => {});
        it("APP-TRACE-001: an APP-prefixed id is evidence", () => {});
      `,
      "int-app-pattern.test.ts",
    );
    expect(intAppPatternDefinitions.map(([id]) => id)).toEqual(["INT-TRACE-001", "APP-TRACE-001"]);

    // A `.tsx` file's helper functions commonly render JSX with a
    // destructured-default parameter and a trailing `return`. Parsing it
    // under `ScriptKind.TS` (JSX disabled) misreads the `<Tag>` as a
    // type-assertion expression; the resulting parse desync can silently
    // swallow every later `it()` in the file, not just the malformed
    // statement, so the source's own `ts.ScriptKind` must track its
    // extension (verified against this exact shape, reduced from a real
    // failure on `UnitEnhancementDialog.test.tsx` where it hid all 6
    // `it()` definitions).
    const tsxDefinitions = collectTestCaseDefinitionsFromSource(
      `
        import { render } from "@testing-library/react";
        import { it, vi } from "vitest";

        function renderDialog(overrides = {}) {
          const onLevelChange = overrides.onLevelChange ?? vi.fn();
          render(
            <UnitEnhancementDialog
              unitDisplayName="alpha"
              {...(overrides.gearEffects !== undefined ? { gearEffects: overrides.gearEffects } : {})}
              sideEnhancement={{
                ...createInitialDraft().allyEnhancement,
                enabled: true,
              }}
              onLevelChange={onLevelChange}
            />,
          );
          return { onLevelChange };
        }

        it("UI-CT-001: opens on the unit", () => {
          const x = 1;
        });
      `,
      "UnitEnhancementDialog.test.tsx",
      /\bUI-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g,
    );
    expect(tsxDefinitions.map(([id]) => id)).toEqual(["UI-CT-001"]);
  });

  describe("collectTestCaseDefinitions directory walk", () => {
    let dir: string;

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("UT-TESTDEFS-002: scans both .test.ts and .test.tsx files, and ignores non-test files", () => {
      dir = mkdtempSync(join(tmpdir(), "test-case-definitions-"));
      writeFileSync(
        join(dir, "logic.test.ts"),
        'import { it } from "vitest";\nit("UI-UT-VAL-001: a .test.ts file is scanned", () => {});\n',
      );
      writeFileSync(
        join(dir, "Component.test.tsx"),
        'import { it } from "vitest";\nit("UI-CT-001: a .test.tsx file is scanned", () => { const el = <div />; });\n',
      );
      writeFileSync(
        join(dir, "helpers.ts"),
        'import { it } from "vitest";\nit("UI-CT-999: a non-test file is not scanned", () => {});\n',
      );

      const definitions = collectTestCaseDefinitions(
        dir,
        undefined,
        /\bUI-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g,
      );

      expect([...definitions.keys()].sort()).toEqual(["UI-CT-001", "UI-UT-VAL-001"]);
    });
  });
});
