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
  it("UT-PLAN-001-001: assigns every uncompleted M7/M8 rule exactly once", () => {
    const manifest = readManifest();
    const assigned = manifest.ruleAssignments.flatMap((assignment) => assignment.ruleIds).sort();
    const uncompleted = RULE_COVERAGE.filter((coverage) => coverage.testCaseIds.length === 0)
      .map((coverage) => coverage.ruleId)
      .sort();

    expect(assigned).toHaveLength(62);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned).toEqual(uncompleted);
    expect(manifest.baseline.rules).toEqual({
      total: 109,
      completedThroughM6: 47,
      remaining: 62,
    });
  });

  it("UT-PLAN-001-002: assigns all 96 incomplete Unit conversion rows by milestone and theme", () => {
    const manifest = readManifest();
    const ledgerCounts = parseIncompleteConversionThemes();
    const manifestCounts = new Map(
      manifest.conversionThemeAssignments.map((assignment) => [
        `${assignment.milestone}:${assignment.theme}`,
        assignment.rowCount,
      ]),
    );

    expect(manifestCounts).toEqual(ledgerCounts);
    expect(manifest.baseline.unitCatalog).toEqual({
      convertedProductionUnits: 69,
      syntheticUnits: 1,
      incompleteConversionRows: 96,
    });
    expect([...manifestCounts.values()].reduce((sum, count) => sum + count, 0)).toBe(
      manifest.baseline.unitCatalog.incompleteConversionRows,
    );
    expect(
      manifest.conversionThemeAssignments
        .filter((assignment) => assignment.milestone === "M7")
        .reduce((sum, assignment) => sum + assignment.rowCount, 0),
    ).toBe(62);
    expect(
      manifest.conversionThemeAssignments
        .filter((assignment) => assignment.milestone === "M8")
        .reduce((sum, assignment) => sum + assignment.rowCount, 0),
    ).toBe(34);
  });

  it("UT-PLAN-001-003: assigns all 26 unconverted Memories exactly once", () => {
    const manifest = readManifest();
    const assignedNames = manifest.unconvertedMemoryAssignments
      .map((assignment) => assignment.name)
      .sort();

    expect(assignedNames).toHaveLength(26);
    expect(new Set(assignedNames).size).toBe(assignedNames.length);
    expect(assignedNames).toEqual(parseUnconvertedMemoryNames());
    expect(manifest.baseline.memoryCatalog).toEqual({
      sourceTotal: 32,
      converted: 6,
      unconverted: 26,
    });
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
    expect(manifest.baselineDate).toBe("2026-07-20");
    expect(manifest.roadmapIssue).toBe(158);
    expect(manifest.tasks).toHaveLength(45);
    expect(new Set(taskIds).size).toBe(taskIds.length);
    expect(new Set(manifest.tasks.map((task) => task.issue)).size).toBe(manifest.tasks.length);
    expect(referencedTaskIds.every((taskId) => taskIds.includes(taskId))).toBe(true);
    expect(
      manifest.ruleAssignments.reduce<Record<"M7" | "M8", number>>(
        (counts, assignment) => {
          const milestone = taskById.get(assignment.taskId)?.milestone;
          if (milestone === "M7" || milestone === "M8") {
            counts[milestone] += assignment.ruleIds.length;
          }
          return counts;
        },
        { M7: 0, M8: 0 },
      ),
    ).toEqual({ M7: 41, M8: 21 });
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

  it("UT-PLAN-001-005: baseline inventory matches Catalog source and Capability registry", () => {
    const manifest = readManifest();
    const unitDirectories = readdirSync(`${repositoryRoot}/apps/api/catalog-src/units`, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    const memoryDirectories = readdirSync(`${repositoryRoot}/apps/api/catalog-src/memories`, {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    const capabilities = JSON.parse(
      readRepositoryFile("apps/api/catalog-src/capabilities.json"),
    ) as readonly { readonly status: string }[];

    expect(unitDirectories).toHaveLength(
      manifest.baseline.unitCatalog.convertedProductionUnits +
        manifest.baseline.unitCatalog.syntheticUnits,
    );
    expect(memoryDirectories).toHaveLength(manifest.baseline.memoryCatalog.converted);
    expect(capabilities).toHaveLength(manifest.baseline.capabilities.total);
    expect(capabilities.filter((capability) => capability.status === "IMPLEMENTED")).toHaveLength(
      manifest.baseline.capabilities.implemented,
    );
    expect(manifest.baseline.capabilities).toEqual({ total: 30, implemented: 1 });
  });
});
