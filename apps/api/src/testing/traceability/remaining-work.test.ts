import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULE_COVERAGE } from "./rule-coverage.js";
import { collectTestCaseDefinitionsFromSource } from "./test-case-definitions.js";

/**
 * 意図的な横断テスト（`12_テスト戦略.md`の co-location 規約における `<module>.test.ts`
 * 命名の例外）。検証対象は src のモジュールではなく`docs/ddd/17_残作業対応表.json`と
 * `15_Unit_Memory変換台帳.md`であり、台帳の件数・割当が Catalog 実データと
 * Capability レジストリに一致し続けることを機械照合する。
 */
type Milestone = "M7" | "M8" | "M9" | "M10";

interface RemainingWorkManifest {
  readonly schemaVersion: 1;
  readonly baselineDate: string;
  readonly roadmapIssue: number;
  readonly baseline: {
    readonly rules: {
      readonly total: number;
      readonly completedThroughM6: number;
      readonly remaining: number;
    };
    readonly unitCatalog: {
      readonly convertedProductionUnits: number;
      readonly syntheticUnits: number;
      readonly incompleteConversionRows: number;
    };
    readonly memoryCatalog: {
      readonly sourceTotal: number;
      readonly converted: number;
      readonly unconverted: number;
    };
    readonly capabilities: { readonly total: number; readonly implemented: number };
  };
  readonly current: {
    readonly rules: {
      readonly total: number;
      readonly completed: number;
      readonly remaining: number;
    };
    readonly unitCatalog: {
      readonly convertedProductionUnits: number;
      readonly syntheticUnits: number;
      readonly incompleteConversionRows: number;
    };
    readonly memoryCatalog: {
      readonly sourceTotal: number;
      readonly converted: number;
      readonly unconverted: number;
    };
  };
  readonly tasks: readonly {
    readonly taskId: string;
    readonly issue: number;
    readonly phase: number;
    readonly milestone: Milestone;
  }[];
  readonly ruleAssignments: readonly {
    readonly taskId: string;
    readonly ruleIds: readonly string[];
  }[];
  readonly conversionThemeAssignments: readonly {
    readonly milestone: "M7" | "M8" | "M9";
    readonly theme: string;
    readonly rowCount: number;
    readonly taskId: string;
  }[];
  readonly unconvertedMemoryAssignments: readonly {
    readonly name: string;
    readonly taskId: string;
  }[];
}

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepositoryFile(path: string): string {
  return readFileSync(`${repositoryRoot}/${path}`, "utf8");
}

function readManifest(): RemainingWorkManifest {
  return JSON.parse(readRepositoryFile("docs/ddd/17_残作業対応表.json")) as RemainingWorkManifest;
}

function stripCode(value: string): string {
  return value.trim().replaceAll("`", "");
}

function parseIncompleteConversionThemes(): Map<string, number> {
  const ledger = readRepositoryFile("docs/ddd/15_Unit_Memory変換台帳.md");
  const detail = ledger.slice(
    ledger.indexOf("### 不完全変換の詳細"),
    ledger.indexOf("## Memory 変換台帳"),
  );
  const counts = new Map<string, number>();

  for (const line of detail.split("\n")) {
    if (!line.startsWith("| `UNIT_")) {
      continue;
    }
    const columns = line.split("|");
    const milestone = stripCode(columns[5] ?? "");
    const theme = stripCode(columns[6] ?? "");
    // M7-010（Issue #177）: M7/M8だけを読むと、`M9`の
    // `UNREACHABLE_BRANCH_BY_RAW_DATA`（`UNIT_SUIRAN_CASINO`、1行）が
    // 割当検証からも件数からも黙って外れる。`対応予定`に現れる
    // マイルストーンはすべて読み、割当先Taskの存在をCIで要求する。
    if (milestone !== "M7" && milestone !== "M8" && milestone !== "M9") {
      continue;
    }
    const key = `${milestone}:${theme}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function parseUnconvertedMemoryNames(): string[] {
  const ledger = readRepositoryFile("docs/ddd/15_Unit_Memory変換台帳.md");
  const table = ledger.slice(
    ledger.indexOf("## Memory 変換台帳"),
    ledger.indexOf("### 未変換 Memory の分類基準"),
  );
  return table
    .split("\n")
    .filter((line) => line.startsWith("|") && line.includes("未変換"))
    .map((line) => line.split("|")[1]?.trim())
    .filter((name): name is string => name !== undefined && name.length > 0)
    .sort();
}

describe("remaining work manifest (PLAN-001)", () => {
  it("UT-PLAN-001-001: assigns every currently uncompleted rule exactly once", () => {
    const manifest = readManifest();
    const assigned = manifest.ruleAssignments.flatMap((assignment) => assignment.ruleIds).sort();
    const uncompleted = RULE_COVERAGE.filter((coverage) => coverage.testCaseIds.length === 0)
      .map((coverage) => coverage.ruleId)
      .sort();

    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned).toEqual(uncompleted);
    expect(manifest.current.rules).toEqual({
      total: RULE_COVERAGE.length,
      completed: RULE_COVERAGE.length - uncompleted.length,
      remaining: uncompleted.length,
    });
    // M7-005-HEAL-LINK（Issue #229）: 実装中に新しいRuleを発見することはあるため
    // （R-HEAL-04「回復リンク」は`APPLY_HEALING_LINK`の転送規則という、baseline
    // 時点の`07_戦闘ルール詳細.md`に存在しなかった契約）、Rule総数は baseline から
    // 増える方向だけを許す。`baseline`自体は履歴として変更しない（本書「更新手順」#3）。
    // 減る方向を許さないことで、Ruleの削除による「見せかけの完了」は引き続き弾く。
    expect(manifest.current.rules.total).toBeGreaterThanOrEqual(manifest.baseline.rules.total);
    expect(manifest.current.rules.completed).toBeGreaterThanOrEqual(
      manifest.baseline.rules.completedThroughM6,
    );
    expect(manifest.current.rules.remaining).toBeLessThanOrEqual(manifest.baseline.rules.remaining);
  });

  it("UT-PLAN-001-002: assigns every current incomplete Unit conversion row by theme", () => {
    const manifest = readManifest();
    const ledgerCounts = parseIncompleteConversionThemes();
    const manifestCounts = new Map(
      manifest.conversionThemeAssignments.map((assignment) => [
        `${assignment.milestone}:${assignment.theme}`,
        assignment.rowCount,
      ]),
    );

    expect(manifestCounts.size).toBe(manifest.conversionThemeAssignments.length);
    expect(manifestCounts).toEqual(ledgerCounts);
    expect([...manifestCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(
      manifest.current.unitCatalog.incompleteConversionRows,
    );
  });

  it("UT-PLAN-001-003: assigns every currently unconverted Memory exactly once", () => {
    const manifest = readManifest();
    const assignedNames = manifest.unconvertedMemoryAssignments
      .map((assignment) => assignment.name)
      .sort();

    expect(new Set(assignedNames).size).toBe(assignedNames.length);
    expect(assignedNames).toEqual(parseUnconvertedMemoryNames());
    expect(assignedNames).toHaveLength(manifest.current.memoryCatalog.unconverted);
  });

  it("UT-PLAN-001-004: references only registered roadmap tasks", () => {
    const manifest = readManifest();
    const taskIds = manifest.tasks.map((task) => task.taskId);
    const taskById = new Map(manifest.tasks.map((task) => [task.taskId, task]));
    const referencedTaskIds = [
      ...manifest.ruleAssignments.map((assignment) => assignment.taskId),
      ...manifest.conversionThemeAssignments.map((assignment) => assignment.taskId),
      ...manifest.unconvertedMemoryAssignments.map((assignment) => assignment.taskId),
    ];

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.baselineDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.roadmapIssue).toBe(158);
    expect(manifest.tasks).toContainEqual(
      expect.objectContaining({ taskId: "PLAN-001", issue: 163 }),
    );
    expect(new Set(taskIds).size).toBe(taskIds.length);
    expect(new Set(manifest.tasks.map((task) => task.issue)).size).toBe(manifest.tasks.length);
    expect(referencedTaskIds.every((taskId) => taskIds.includes(taskId))).toBe(true);
    // Rule割当の許容milestoneはRuleを持つ実装マイルストーンに限る。M10は
    // TEX-001（Issue #402、戦術演習）の設計時新設Rule（R-TEX-01〜10）が加わり許容へ追加した。
    expect(
      manifest.ruleAssignments.every((assignment) => {
        const milestone = taskById.get(assignment.taskId)?.milestone;
        return milestone === "M7" || milestone === "M8" || milestone === "M10";
      }),
    ).toBe(true);
    expect(
      manifest.conversionThemeAssignments.every(
        (assignment) => taskById.get(assignment.taskId)?.milestone === assignment.milestone,
      ),
    ).toBe(true);
    expect(
      manifest.unconvertedMemoryAssignments.every(
        (assignment) => taskById.get(assignment.taskId)?.milestone === "M7",
      ),
    ).toBe(true);
  });

  it("UT-PLAN-001-006: preserves an internally coherent historical baseline", () => {
    const { baseline } = readManifest();

    expect(baseline.rules.completedThroughM6 + baseline.rules.remaining).toBe(baseline.rules.total);
    expect(baseline.memoryCatalog.converted + baseline.memoryCatalog.unconverted).toBe(
      baseline.memoryCatalog.sourceTotal,
    );
    expect(baseline.capabilities.implemented).toBeLessThanOrEqual(baseline.capabilities.total);
    expect(baseline.unitCatalog.convertedProductionUnits).toBeGreaterThan(0);
    expect(baseline.unitCatalog.syntheticUnits).toBeGreaterThanOrEqual(0);
    expect(baseline.unitCatalog.incompleteConversionRows).toBeGreaterThanOrEqual(0);
  });

  it("UT-PLAN-001-008 (REL-003, Issue #200): no production definition anywhere in catalog-src grants a marker that could stand for 「ワンペア」, so SKL_SUIRAN_CASINO_AS1's 2-target branch stays unreachable", () => {
    // `UNREACHABLE_BRANCH_BY_RAW_DATA`（`15_Unit_Memory変換台帳.md`）は「実装できない
    // ギャップ」ではなく**到達不能という判断**であり、その判断が最終承認時点でも
    // 維持されているかを確認して初めて台帳から除去できる（Issue #200「M7-010からの
    // 引継ぎ」）。`REL-003` で確認して行を除去したため、以後はこのテストが
    // 「到達手段が現れていない」ことの常設の見張りになる。
    //
    // Markerは `markerId` しか持たず表示名を持たないため、原文語「ワンペア」との
    // 対応は**ID表記**でしか機械判定できない。ローマ字化の揺れを拾うため
    // `PAIR` を含むIDを全面的に禁じ、併せて劉翠蘭自身が配るMarkerが
    // 「スリーカード」1種のままであることを固定する。どちらかが変われば、
    // `SKL_SUIRAN_CASINO_AS1` の対象拡張を近似なしへ実装し直す必要がある。
    const grantedMarkerIds = (directory: string): readonly string[] => {
      const root = `${repositoryRoot}/apps/api/catalog-src/${directory}`;
      return readdirSync(root)
        .flatMap((entry) =>
          readdirSync(`${root}/${entry}`)
            .filter((file) => file.endsWith(".json"))
            .map((file) => readFileSync(`${root}/${entry}/${file}`, "utf8")),
        )
        .flatMap((source) => [...source.matchAll(/"markerId":\s*"([A-Z0-9_]+)"/g)])
        .map((match) => match[1]!);
    };
    const allMarkerIds = [...grantedMarkerIds("units"), ...grantedMarkerIds("memories")];

    // 空振り防止: 走査がMarkerを1件も拾えていないなら、下の2つの不在は無意味になる。
    expect(allMarkerIds.length).toBeGreaterThan(0);
    expect(allMarkerIds.filter((markerId) => markerId.includes("PAIR"))).toEqual([]);
    expect([...new Set(grantedMarkerIds("units").filter((id) => id.includes("SUIRAN_CASINO")))]) //
      .toEqual(["MARKER_SUIRAN_CASINO_THREE_CARD"]);

    // 到達不能判断を維持したので、台帳側の該当テーマも残っていてはならない。
    const { conversionThemeAssignments } = readManifest();
    expect(
      conversionThemeAssignments.filter(
        (assignment) => assignment.theme === "UNREACHABLE_BRANCH_BY_RAW_DATA",
      ),
    ).toEqual([]);
  });

  it("UT-PLAN-001-007: counts only test titles and preserves duplicate definitions", () => {
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
