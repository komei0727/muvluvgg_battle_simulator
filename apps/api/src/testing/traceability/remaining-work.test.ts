import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { RULE_COVERAGE } from "./rule-coverage.js";

type Milestone = "M7" | "M8" | "M9";

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
    readonly capabilities: { readonly total: number; readonly implemented: number };
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
    readonly milestone: "M7" | "M8";
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
    if (milestone !== "M7" && milestone !== "M8") {
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

interface TestCaseDefinition {
  readonly file: string;
  readonly position: number;
}

const TEST_CASE_ID_PATTERN = /\b(?:UT|IT|SCN|E2E)-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g;

function hasTestFunctionRoot(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "it" || expression.text === "test";
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return hasTestFunctionRoot(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return hasTestFunctionRoot(expression.expression);
  }
  return false;
}

function collectTestCaseDefinitionsFromSource(
  sourceText: string,
  file: string,
): readonly [string, TestCaseDefinition][] {
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const definitions: [string, TestCaseDefinition][] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && hasTestFunctionRoot(node.expression)) {
      const title = node.arguments[0];
      if (
        title !== undefined &&
        (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
      ) {
        for (const match of title.text.matchAll(TEST_CASE_ID_PATTERN)) {
          definitions.push([match[0], { file, position: title.getStart(sourceFile) }]);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return definitions;
}

function collectTestCaseDefinitions(
  directory: string,
  into = new Map<string, TestCaseDefinition[]>(),
): Map<string, TestCaseDefinition[]> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      collectTestCaseDefinitions(path, into);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
      continue;
    }
    for (const [id, definition] of collectTestCaseDefinitionsFromSource(
      readFileSync(path, "utf8"),
      path,
    )) {
      const definitions = into.get(id) ?? [];
      definitions.push(definition);
      into.set(id, definitions);
    }
  }
  return into;
}

describe("remaining work manifest (PLAN-001)", () => {
  it("UT-PLAN-001-001: assigns every currently uncompleted M7/M8 rule exactly once", () => {
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
    expect(manifest.current.rules.total).toBe(manifest.baseline.rules.total);
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
    expect(
      manifest.ruleAssignments.every((assignment) => {
        const milestone = taskById.get(assignment.taskId)?.milestone;
        return milestone === "M7" || milestone === "M8";
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

  it("UT-PLAN-001-005: current inventory matches Catalog source and Capability registry", () => {
    const manifest = readManifest();
    const unitDirectories = readdirSync(`${repositoryRoot}/apps/api/catalog-src/units`, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    const syntheticUnitDirectories = unitDirectories.filter(
      (entry) => entry.name === "UNIT_CI_SMOKE_TEST",
    );
    const memoryDirectories = readdirSync(`${repositoryRoot}/apps/api/catalog-src/memories`, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    const capabilities = JSON.parse(
      readRepositoryFile("apps/api/catalog-src/capabilities.json"),
    ) as readonly {
      readonly capabilityId: string;
      readonly schemaStatus: string;
      readonly runtimeStatus: string;
      readonly implementationTaskId: string;
      readonly verification: {
        readonly productionDefinitionIds: readonly string[];
        readonly testCaseIds: readonly string[];
      };
    }[];
    const remainingTaskIds = new Set(manifest.tasks.map((task) => task.taskId));
    const testCaseDefinitions = collectTestCaseDefinitions(`${repositoryRoot}/apps/api/src`);

    expect(unitDirectories).toHaveLength(
      manifest.current.unitCatalog.convertedProductionUnits +
        manifest.current.unitCatalog.syntheticUnits,
    );
    expect(syntheticUnitDirectories).toHaveLength(manifest.current.unitCatalog.syntheticUnits);
    expect(unitDirectories.length - syntheticUnitDirectories.length).toBe(
      manifest.current.unitCatalog.convertedProductionUnits,
    );
    expect(memoryDirectories).toHaveLength(manifest.current.memoryCatalog.converted);
    expect(
      manifest.current.memoryCatalog.converted + manifest.current.memoryCatalog.unconverted,
    ).toBe(manifest.current.memoryCatalog.sourceTotal);
    expect(manifest.current.memoryCatalog.sourceTotal).toBe(
      manifest.baseline.memoryCatalog.sourceTotal,
    );
    expect(manifest.current.memoryCatalog.converted).toBeGreaterThanOrEqual(
      manifest.baseline.memoryCatalog.converted,
    );
    expect(manifest.current.memoryCatalog.unconverted).toBeLessThanOrEqual(
      manifest.baseline.memoryCatalog.unconverted,
    );
    expect(capabilities).toHaveLength(manifest.current.capabilities.total);
    expect(
      capabilities.filter((capability) => capability.runtimeStatus === "IMPLEMENTED"),
    ).toHaveLength(manifest.current.capabilities.implemented);
    expect(capabilities.every((capability) => capability.schemaStatus === "SUPPORTED")).toBe(true);
    expect(
      capabilities
        .filter((capability) => capability.runtimeStatus !== "IMPLEMENTED")
        .every((capability) => remainingTaskIds.has(capability.implementationTaskId)),
    ).toBe(true);
    expect(new Set(capabilities.map((capability) => capability.capabilityId)).size).toBe(
      capabilities.length,
    );
    for (const capability of capabilities.filter(
      (candidate) => candidate.runtimeStatus === "IMPLEMENTED",
    )) {
      expect(new Set(capability.verification.testCaseIds).size).toBe(
        capability.verification.testCaseIds.length,
      );
      for (const testCaseId of capability.verification.testCaseIds) {
        expect(
          testCaseDefinitions.get(testCaseId) ?? [],
          `${capability.capabilityId} verification testCaseId "${testCaseId}" must identify exactly one test definition`,
        ).toHaveLength(1);
      }
    }
    expect(manifest.current.capabilities.implemented).toBeGreaterThanOrEqual(
      manifest.baseline.capabilities.implemented,
    );
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

  it("UT-PLAN-001-007: counts only test titles and preserves duplicate definitions", () => {
    const definitions = collectTestCaseDefinitionsFromSource(
      `
        // IT-TRACE-001: a comment is not evidence
        const note = "IT-TRACE-002: an arbitrary string is not evidence";
        it("IT-TRACE-003: first definition", () => {});
        it.each([[1]])("IT-TRACE-003: duplicate definition", () => {});
      `,
      "traceability.test.ts",
    );

    expect(definitions.map(([id]) => id)).toEqual(["IT-TRACE-003", "IT-TRACE-003"]);
  });
});
