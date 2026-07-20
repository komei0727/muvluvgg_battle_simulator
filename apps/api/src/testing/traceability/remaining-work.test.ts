import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    ) as readonly { readonly status: string }[];

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
    expect(capabilities.filter((capability) => capability.status === "IMPLEMENTED")).toHaveLength(
      manifest.current.capabilities.implemented,
    );
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
});
