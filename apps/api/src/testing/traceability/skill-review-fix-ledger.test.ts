import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProductionSnapshot } from "../fixtures/index.js";
import { hitConditionedSkill } from "../production-unit/hit-condition.js";
import { allExerciseEnemyProductionUnitIds } from "../scenario/run-production-battle.js";
import { REVIEWED_UNIT_IDS, stageGScenarios } from "../scenario/stage-g-sweep.js";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";
import {
  FIX_DELIVERIES,
  OPEN_ISSUE_TITLES,
  OPEN_RELATED_ISSUES,
  SKILL_REVIEW_FIX_ANCHORS,
  SWEEP_ANCHOR_TEST_IDS,
  UNIT_OPEN_ISSUES,
  type FixId,
} from "./skill-review-fix-ledger.js";

/**
 * スキルレビューの要修正207行（`docs/skill-reviews/fix-issues/対応表.md`）と修正台帳・
 * 恒久テスト・評価シートの同期を検査する。各行の必須の担当がすべて実PRへ届き、担当ごとに
 * 実在する恒久テストを持ち、評価シートの対応状況・修正参照・再検証結果が台帳と一致する。
 */
const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));
const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));
const DOCS_DIR = fileURLToPath(new URL("../../../../../docs/skill-reviews", import.meta.url));
const CORRESPONDENCE = readFileSync(`${DOCS_DIR}/fix-issues/対応表.md`, "utf8");
const SHEET = readFileSync(`${DOCS_DIR}/評価シート.md`, "utf8");

interface ReviewRow {
  readonly sr: string;
  readonly unitDefinitionId: string;
  readonly skillDefinitionIds: readonly string[];
  readonly fixes: readonly string[];
}

/** 対応表の評価行（`| SR-xxx | スキル・元資料 | 必須の修正Issue案と担当範囲 | …`）。 */
const ROWS: readonly ReviewRow[] = [
  ...CORRESPONDENCE.matchAll(/^\| (?:<a id="[^"]*"><\/a>)?(SR-\d{3}) \|(.*)$/gm),
].map((match) => {
  const cells = match[2]!.split(" | ");
  return {
    sr: match[1]!,
    unitDefinitionId: /\[(UNIT_[A-Z0-9_]+)\]/.exec(cells[0]!)![1]!,
    skillDefinitionIds: [...cells[0]!.matchAll(/`(SKL_[A-Z0-9_]+)`/g)].map((m) => m[1]!),
    fixes: [...new Set([...cells[1]!.matchAll(/FIX-(\d{2})/g)].map((m) => `FIX-${m[1]}`))].sort(),
  };
});

/** 評価シートの見出し単位の節（次の`## `まで）。 */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  expect(start, `section "${heading}"`).toBeGreaterThanOrEqual(0);
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

function tableRowsOf(section: string, firstCell: RegExp): Map<string, readonly string[]> {
  const rows = new Map<string, readonly string[]>();
  for (const line of section.split("\n")) {
    const cells = line.split(" | ");
    const key = firstCell.exec(cells[0] ?? "")?.[1];
    if (key !== undefined) {
      rows.set(key, cells);
    }
  }
  return rows;
}

describe("skill-review fix ledger (Issue #840)", () => {
  it("UT-TRACEABILITY-014: the ledger holds exactly the 207 rows of the correspondence table, each with exactly its assigned fixes, and every fix reaches a merged PR", () => {
    expect(ROWS).toHaveLength(207);
    expect(Object.keys(SKILL_REVIEW_FIX_ANCHORS).sort()).toEqual(ROWS.map((row) => row.sr).sort());
    for (const row of ROWS) {
      expect(row.fixes.length, `${row.sr} has at least one assigned fix`).toBeGreaterThan(0);
      expect(Object.keys(SKILL_REVIEW_FIX_ANCHORS[row.sr]!).sort(), row.sr).toEqual(row.fixes);
      for (const fix of row.fixes) {
        expect(FIX_DELIVERIES[fix as FixId], `${row.sr} ${fix}`).toBeDefined();
      }
    }
  });

  it("UT-TRACEABILITY-015: every assigned fix of every row is anchored to an executable test that names the row (its SR or one of its skills) or sweeps the row's skill", () => {
    const definitions = collectTestCaseDefinitions(SRC_DIR);
    const sources = new Map<string, string>();
    const sourceOf = (file: string): string => {
      if (!sources.has(file)) {
        sources.set(file, readFileSync(file, "utf8"));
      }
      return sources.get(file)!;
    };
    const sweepSnapshot = loadProductionSnapshot(CATALOG_DIR, [
      ...new Set(ROWS.map((row) => row.unitDefinitionId)),
    ]);
    const problems: string[] = [];
    for (const row of ROWS) {
      for (const [fix, testIds] of Object.entries(SKILL_REVIEW_FIX_ANCHORS[row.sr]!)) {
        if (testIds.length === 0) {
          problems.push(`${row.sr} ${fix}: no anchor`);
        }
        for (const testId of testIds) {
          const found = definitions.get(testId);
          if (found === undefined || found.length !== 1) {
            problems.push(`${row.sr} ${fix}: ${testId} is not exactly one executable test`);
            continue;
          }
          if (SWEEP_ANCHOR_TEST_IDS.has(testId)) {
            if (
              !row.skillDefinitionIds.some(
                (skillId) => hitConditionedSkill(sweepSnapshot, skillId) !== undefined,
              )
            ) {
              problems.push(`${row.sr} ${fix}: ${testId} does not sweep the row's skill`);
            }
            continue;
          }
          const source = sourceOf(found[0]!.file);
          const names = [row.sr, ...row.skillDefinitionIds];
          if (!names.some((name) => new RegExp(`${name}(?![0-9A-Z_])`).test(source))) {
            problems.push(`${row.sr} ${fix}: ${testId}'s file names neither the SR nor its skill`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    // 全テストファイルの構文解析と本番Catalogの読み込みを伴い、カバレッジ計測下では既定の5秒を超える。
  }, 120_000);

  it("UT-TRACEABILITY-016: the evaluation sheet records each row's PRs and anchor tests, and marks the row done unless a related issue is still open", () => {
    const fixTable = tableRowsOf(sectionOf(SHEET, "指摘事項・修正後の確認"), /^\| (SR-\d{3})\s*$/);
    const statusBySr = new Map<string, string>();
    for (const line of SHEET.split("\n")) {
      const sr = /^\| (?:AS|PS|EX)\d*：.*\| (SR-\d{3})<br>/.exec(line)?.[1];
      if (sr !== undefined) {
        statusBySr.set(sr, line.split(" | ")[4]!.replaceAll("*", "").trim());
      }
    }
    const problems: string[] = [];
    for (const row of ROWS) {
      const cells = fixTable.get(row.sr);
      if (cells === undefined) {
        problems.push(`${row.sr}: missing from the fix table`);
        continue;
      }
      const references = cells[cells.length - 2]!;
      const verification = cells[cells.length - 1]!;
      const open = OPEN_RELATED_ISSUES[row.sr];
      const expectedStatus = open === undefined ? "完了" : "再検証待ち";
      if (!verification.startsWith(expectedStatus)) {
        problems.push(`${row.sr}: verification should start with ${expectedStatus}`);
      }
      for (const issue of open ?? []) {
        if (!verification.includes(`#${issue}`)) {
          problems.push(`${row.sr}: verification omits open issue #${issue}`);
        }
      }
      if (statusBySr.get(row.sr) !== expectedStatus) {
        problems.push(`${row.sr}: unit table status ${statusBySr.get(row.sr)} ≠ ${expectedStatus}`);
      }
      for (const [fix, testIds] of Object.entries(SKILL_REVIEW_FIX_ANCHORS[row.sr]!)) {
        if (!references.includes(`PR #${FIX_DELIVERIES[fix as FixId].pullRequest}`)) {
          problems.push(`${row.sr}: references omit the ${fix} PR`);
        }
        for (const testId of testIds) {
          if (!verification.includes(`\`${testId}\``)) {
            problems.push(`${row.sr}: verification omits ${testId}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("UT-TRACEABILITY-017: the stage-G record lists the 84 reviewed units with their sweep scenarios, open issues and review rows", () => {
    const stageG = tableRowsOf(
      sectionOf(SHEET, "段階G：84ユニットの組み合わせ確認"),
      /^\| `(UNIT_[A-Z0-9_]+)`\s*$/,
    );
    expect([...stageG.keys()].sort()).toEqual([...REVIEWED_UNIT_IDS].sort());
    const scenarios = stageGScenarios(allExerciseEnemyProductionUnitIds(CATALOG_DIR));
    const problems: string[] = [];
    for (const unitId of REVIEWED_UNIT_IDS) {
      const [, scenarioCell, , unconfirmed, related] = stageG.get(unitId)!;
      const expectedScenarios = [
        ...scenarios.filter((s) => s.ally.includes(unitId)),
        ...scenarios.filter((s) => s.kind === "PARTY" && s.enemy.includes(unitId)),
      ].map((s) => s.scenarioId);
      const listed = [...scenarioCell!.matchAll(/(?:EX|PV)-S\d+-P\d+|FOCUS-[A-Z0-9-]+/g)].map(
        (m) => m[0],
      );
      if (listed.join(",") !== expectedScenarios.join(",")) {
        problems.push(`${unitId}: scenarios ${listed.join(",")}`);
      }
      const issues = UNIT_OPEN_ISSUES[unitId] ?? [];
      const listedIssues = [...unconfirmed!.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
      if (listedIssues.join(",") !== issues.join(",")) {
        problems.push(`${unitId}: open issues ${listedIssues.join(",")}`);
      }
      for (const issue of issues) {
        if (OPEN_ISSUE_TITLES[issue] === undefined) {
          problems.push(`${unitId}: #${issue} has no title`);
        }
      }
      const expectedSrs = ROWS.filter((row) => row.unitDefinitionId === unitId).map(
        (row) => row.sr,
      );
      const listedSrs = [...related!.matchAll(/SR-\d{3}/g)].map((m) => m[0]);
      if (listedSrs.join(",") !== expectedSrs.join(",")) {
        problems.push(`${unitId}: related rows ${listedSrs.join(",")}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
