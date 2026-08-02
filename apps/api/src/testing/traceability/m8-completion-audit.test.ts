import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULE_COVERAGE } from "./rule-coverage.js";

/**
 * DMG-011（Issue #186、M8完了監査）が固定する監査不変条件。
 *
 * `m7-completion-audit.test.ts`が「残作業の割当先Taskが着手可能であること」を
 * 検証するのに対し、ここは**M8という完了境界そのもの**を機械化する。M7完了監査は
 * 「所有者不在」（closeしたIssueへ残作業が残る）を検出したが、マイルストーン単位の
 * 完了は別の形でも壊れる — 台帳の件数は合っているのに、そのマイルストーンが
 * 引き受けたRule・変換行・Capabilityのどれかが黙って次のマイルストーンへ滑り込む。
 *
 * ここでは次を機械検証する。
 *
 * 1. `13_実装計画.md`「M8：高度ダメージ 21件」が列挙する21ルールと、M8の実装中に
 *    新設した4ルールが、すべてCoverage台帳へ実行可能なテストを持つ
 * 2. M8 Taskが所有する未完了Rule・不完全変換テーマが1件も残っていない
 * 3. M8 Taskが完了責任を持つCapabilityがすべて`IMPLEMENTED`である
 */

/**
 * `13_実装計画.md`「M8：高度ダメージ 21件」の21ルール。同節の列挙をそのまま写す
 * （範囲表記`R-SHD-01`〜`R-SHD-03`は展開する）。
 */
const M8_PLANNED_RULE_IDS = [
  "R-SKL-03",
  "R-ACTN-02",
  "R-ACTN-03",
  "R-DMG-03",
  "R-DMG-04",
  "R-DMG-05",
  "R-SHD-01",
  "R-SHD-02",
  "R-SHD-03",
  "R-SUB-01",
  "R-SUB-02",
  "R-INT-01",
  "R-INT-02",
  "R-INT-03",
  "R-LNK-01",
  "R-LNK-02",
  "R-LNK-03",
  "R-DOT-01",
  "R-DOT-02",
  "R-DOT-03",
  "R-DOT-04",
] as const;

/**
 * M8の実装中に新設したルール。いずれも`R-HIT-04`／`R-HIT-05`（`M7-018`）と同じく、
 * raw原文とproduction定義だけが存在して`07_戦闘ルール詳細.md`にRule定義が無かった
 * ものであり、計画の21件には現れない。完了境界は21件ではなくこの25件である。
 */
const M8_DISCOVERED_RULE_IDS = ["R-CRT-03", "R-CFS-01", "R-CFS-02", "R-DTH-01"] as const;

type TaskStatus = "OPEN" | "CLOSED";

interface RemainingWorkTask {
  readonly taskId: string;
  readonly issue: number;
  readonly phase: number;
  readonly milestone: string;
  readonly status: TaskStatus;
}

interface M8AuditManifest {
  readonly tasks: readonly RemainingWorkTask[];
  readonly ruleAssignments: readonly {
    readonly taskId: string;
    readonly ruleIds: readonly string[];
  }[];
  readonly conversionThemeAssignments: readonly {
    readonly taskId: string;
    readonly milestone: string;
    readonly theme: string;
    readonly rowCount: number;
  }[];
  readonly m8Audit: {
    readonly auditDate: string;
    readonly auditIssue: number;
    readonly plannedRuleIds: readonly string[];
    readonly discoveredRuleIds: readonly string[];
    readonly resolvedConversionRows: number;
  };
}

interface CapabilityEntry {
  readonly capabilityId: string;
  readonly runtimeStatus: string;
  readonly implementationTaskId: string;
}

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function readManifest(): M8AuditManifest {
  return JSON.parse(
    readFileSync(`${repositoryRoot}/docs/ddd/17_残作業対応表.json`, "utf8"),
  ) as M8AuditManifest;
}

function readCapabilities(): readonly CapabilityEntry[] {
  return JSON.parse(
    readFileSync(`${repositoryRoot}/apps/api/catalog-src/capabilities.json`, "utf8"),
  ) as readonly CapabilityEntry[];
}

describe("M8 completion audit (DMG-011)", () => {
  it("UT-AUDIT-M8-001: every rule M8 committed to is backed by the coverage ledger", () => {
    const manifest = readManifest();
    const coverageByRuleId = new Map(
      RULE_COVERAGE.map((coverage) => [coverage.ruleId, coverage] as const),
    );
    const expected = [...M8_PLANNED_RULE_IDS, ...M8_DISCOVERED_RULE_IDS];

    // 台帳の宣言が計画の写しから乖離していないこと（監査対象の取りこぼし防止）。
    expect([...manifest.m8Audit.plannedRuleIds].sort()).toEqual([...M8_PLANNED_RULE_IDS].sort());
    expect([...manifest.m8Audit.discoveredRuleIds].sort()).toEqual(
      [...M8_DISCOVERED_RULE_IDS].sort(),
    );
    expect(M8_PLANNED_RULE_IDS).toHaveLength(21);

    const uncovered = expected.filter(
      (ruleId) => (coverageByRuleId.get(ruleId)?.testCaseIds.length ?? 0) === 0,
    );
    expect(
      uncovered,
      `M8 rules still without executable coverage: ${JSON.stringify(uncovered)}`,
    ).toEqual([]);
  });

  it("UT-AUDIT-M8-002: no M8 task still owns an uncompleted rule or an incomplete conversion row", () => {
    const manifest = readManifest();
    const m8TaskIds = new Set(
      manifest.tasks.filter((task) => task.milestone === "M8").map((task) => task.taskId),
    );

    const rules = manifest.ruleAssignments
      .filter((assignment) => m8TaskIds.has(assignment.taskId))
      .flatMap((assignment) =>
        assignment.ruleIds.map((ruleId) => `${assignment.taskId} -> ${ruleId}`),
      );
    const rows = manifest.conversionThemeAssignments
      .filter((assignment) => m8TaskIds.has(assignment.taskId) || assignment.milestone === "M8")
      .map((assignment) => `${assignment.taskId} -> ${assignment.theme}`);

    expect(rules, "M8 is complete only when no M8 task owns a remaining rule").toEqual([]);
    expect(rows, "M8 is complete only when no incomplete conversion row is assigned to M8").toEqual(
      [],
    );
    // baselineがM8へ割り当てた34行を全件解消した記録（`15_Unit_Memory変換台帳.md`）。
    expect(manifest.m8Audit.resolvedConversionRows).toBe(34);
  });

  it("UT-AUDIT-M8-003: every Capability an M8 task owns is IMPLEMENTED", () => {
    const manifest = readManifest();
    const m8TaskIds = new Set(
      manifest.tasks.filter((task) => task.milestone === "M8").map((task) => task.taskId),
    );
    const unimplemented = readCapabilities()
      .filter((capability) => m8TaskIds.has(capability.implementationTaskId))
      .filter((capability) => capability.runtimeStatus !== "IMPLEMENTED")
      .map((capability) => `${capability.capabilityId} -> ${capability.implementationTaskId}`);

    expect(
      unimplemented.sort(),
      "an M8-owned Capability must not stay PLANNED after the M8 completion audit",
    ).toEqual([]);
  });
});
