import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULE_COVERAGE } from "./rule-coverage.js";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

/**
 * `REL-003`（Issue #200、M9リリース承認）が固定する監査不変条件。
 *
 * `m8-completion-audit.test.ts` が「M8という完了境界」を機械化したのと同じ形で、
 * ここは**M9のリリース証跡そのもの**を機械化する。M9の完了条件は
 * 「主要22 Scenarioを検証し、全ルールCoverageとCatalog revisionをrelease証跡に
 * する」（`13_実装計画.md`「M9 完成・性能・リリース準備」）であり、証跡が
 * 文章だけで残っていると、後からシナリオが消えても・ルールが被覆を失っても・
 * 出荷したCatalogが別物になっても誰も気づけない。
 *
 * ここでは次を機械検証する。
 *
 * 1. `12_テスト戦略.md`「基準シナリオ」表が定める主要22シナリオが、リポジトリに
 *    実行対象のテストとして実在する（退役した `SCN-BTL-022` は欠番のまま）
 * 2. Coverage台帳に実行可能テストを持たないルールが1件も**M9へ残っていない**
 *    （残る未完了は必ずM9以外のOPEN Taskが所有する）。M9 Taskが不完全変換行を
 *    所有していないことも併せて見る
 * 3. release証跡として記録した `catalogRevision` が、実際に出荷する
 *    `catalog/manifest.json` と一致する
 */

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));

type TaskStatus = "OPEN" | "CLOSED";

interface M9AuditManifest {
  readonly tasks: readonly {
    readonly taskId: string;
    readonly issue: number;
    readonly milestone: string;
    readonly status: TaskStatus;
  }[];
  readonly ruleAssignments: readonly {
    readonly taskId: string;
    readonly ruleIds: readonly string[];
  }[];
  readonly conversionThemeAssignments: readonly {
    readonly taskId: string;
    readonly milestone: string;
    readonly theme: string;
  }[];
  readonly m9Audit: {
    readonly auditDate: string;
    readonly auditIssue: number;
    readonly catalogRevision: string;
    readonly scenarioIds: readonly string[];
    readonly retiredScenarioIds: readonly string[];
  };
}

function readRepositoryFile(path: string): string {
  return readFileSync(`${repositoryRoot}/${path}`, "utf8");
}

function readManifest(): M9AuditManifest {
  return JSON.parse(readRepositoryFile("docs/ddd/17_残作業対応表.json")) as M9AuditManifest;
}

/**
 * `12_テスト戦略.md`「基準シナリオ」表が列挙するシナリオID。表を正本にするのは、
 * 監査側へIDを書き写すと**表からシナリオが消えても監査が気づけない**ためである
 * （`m8-completion-audit.test.ts` が計画の21ルールを写している箇所は、
 * `plannedRuleIds` との突き合わせで同じ穴を塞いでいる）。
 */
function baselineScenarioIdsFromSpec(): readonly string[] {
  const strategy = readRepositoryFile("docs/ddd/12_テスト戦略.md");
  const table = strategy.slice(
    strategy.indexOf("### 基準シナリオ"),
    strategy.indexOf("各シナリオを巨大な一つのテストにまとめず"),
  );
  return [...table.matchAll(/^\| `(SCN-BTL-\d+)`/gm)].map((match) => match[1]!);
}

/**
 * M9が引き受けた番号帯の上限。`13_実装計画.md`「M9 完成・性能・リリース準備」が
 * 「`SCN-BTL-001`〜`023` のうち退役分を除く22件」と定めており、`024` 以降は
 * `TEX-001`（戦術演習シミュレータ実装、M10）の担当である。番号で切るのは、
 * M10がシナリオを増やしてもM9の証跡の母数が勝手に動かないようにするため。
 */
const M9_LAST_SCENARIO_NUMBER = 23;

function scenarioNumber(scenarioId: string): number {
  return Number(scenarioId.slice("SCN-BTL-".length));
}

describe("M9 completion audit (REL-003)", () => {
  it("UT-AUDIT-M9-001: every baseline scenario M9 committed to exists as an executable test, and the retired ID stays a gap", () => {
    const manifest = readManifest();
    const declared = baselineScenarioIdsFromSpec();
    const retired = new Set(manifest.m9Audit.retiredScenarioIds);

    // 表そのものが監査対象の母数になる。表から消えた／増えたシナリオは
    // 台帳との突き合わせで落ちる。
    const expected = declared.filter(
      (scenarioId) =>
        scenarioNumber(scenarioId) <= M9_LAST_SCENARIO_NUMBER && !retired.has(scenarioId),
    );
    expect(
      expected,
      "M9 committed to SCN-BTL-001..023 minus the retired IDs; changing that set must be a deliberate ledger update",
    ).toHaveLength(22);
    expect([...manifest.m9Audit.scenarioIds].sort()).toEqual([...expected].sort());

    // 退役IDは欠番のままにする（`REF-023`／Issue #352 でCapability概念ごと廃止した）。
    for (const scenarioId of retired) {
      expect(declared, `${scenarioId} must stay a gap in the baseline table`).not.toContain(
        scenarioId,
      );
    }

    // 実行対象のテストとして実在すること。`it.skip`/`todo`/条件付き無効化・
    // コメント内・文字列内は `collectTestCaseDefinitions` が除いている。
    const definitions = collectTestCaseDefinitions(apiSrcPath);
    const missing = expected.filter(
      (scenarioId) => (definitions.get(scenarioId) ?? []).length === 0,
    );
    expect(
      missing,
      `baseline scenarios without an executable test: ${JSON.stringify(missing)}`,
    ).toEqual([]);
    // 退役IDのテストが復活していないこと（欠番の実効性）。
    for (const scenarioId of retired) {
      expect(definitions.get(scenarioId) ?? []).toEqual([]);
    }
    // `collectTestCaseDefinitions` は src 全体を走査するため、coverage計測下では
    // 既定の5秒に収まらない（`UT-TRACEABILITY-005` と同じ理由・同じ猶予）。
  }, 30000);

  it("UT-AUDIT-M9-002: no rule without executable coverage is left to M9, and no M9 task owns an incomplete conversion row", () => {
    const manifest = readManifest();
    const taskById = new Map(manifest.tasks.map((task) => [task.taskId, task]));
    const uncovered = RULE_COVERAGE.filter((coverage) => coverage.testCaseIds.length === 0).map(
      (coverage) => coverage.ruleId,
    );
    const ownerByRuleId = new Map(
      manifest.ruleAssignments.flatMap((assignment) =>
        assignment.ruleIds.map((ruleId) => [ruleId, assignment.taskId] as const),
      ),
    );

    // 未完了ルールは残っていてよいが、**M9が所有していてはならない**。M9の完了は
    // 「M9が引き受けた責務を全部果たした」ことであって「全ルールが完成した」ことでは
    // ない（`R-TGT-06` は production需要待ち、`R-TEX-*` はM10の設計時新設）。
    const strandedOnM9 = uncovered.filter((ruleId) => {
      const owner = ownerByRuleId.get(ruleId);
      return owner === undefined || taskById.get(owner)?.milestone === "M9";
    });
    expect(
      strandedOnM9,
      `rules without coverage that M9 still owns (or that nobody owns): ${JSON.stringify(strandedOnM9)}`,
    ).toEqual([]);

    // 引き取り先は実在するOPEN Taskでなければならない（closeしたIssueへ残作業を
    // 預けたまま完了扱いにする「所有者不在」を防ぐ。`m7-completion-audit` と同趣旨）。
    for (const ruleId of uncovered) {
      const owner = taskById.get(ownerByRuleId.get(ruleId)!);
      expect(owner, `${ruleId} must be owned by a registered task`).toBeDefined();
      expect(owner!.status, `${ruleId} is owned by ${owner!.taskId}, which must stay OPEN`).toBe(
        "OPEN",
      );
    }

    const m9TaskIds = new Set(
      manifest.tasks.filter((task) => task.milestone === "M9").map((task) => task.taskId),
    );
    expect(
      manifest.conversionThemeAssignments
        .filter((assignment) => m9TaskIds.has(assignment.taskId) || assignment.milestone === "M9")
        .map((assignment) => `${assignment.taskId} -> ${assignment.theme}`),
    ).toEqual([]);
  });

  it("UT-AUDIT-M9-003: the catalogRevision recorded as release evidence is the revision actually shipped", () => {
    const manifest = readManifest();
    const shipped = JSON.parse(readRepositoryFile("apps/api/catalog/manifest.json")) as {
      readonly catalogRevision: string;
    };

    // Catalogを再生成するときは `catalogRevision` を必ず上げる運用
    // （`check-catalog-src` がdriftを検出する）なので、release証跡の側も同じ
    // 変更で更新する。ここが等しいことだけが「記録した版＝出荷した版」を保証する。
    expect(manifest.m9Audit.catalogRevision).toBe(shipped.catalogRevision);
    expect(manifest.m9Audit.auditIssue).toBe(200);
    expect(manifest.m9Audit.auditDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
