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
 * 2. Coverage台帳に実行可能テストを持たないルールが、下で列挙した繰り越し分と
 *    **完全に一致**する（M9以外のOPEN Taskが所有する2類型だけ）。M9 Taskが
 *    不完全変換行を所有していないことも併せて見る。この完了条件はIssue #200 の
 *    「スコープ変更履歴」で合意・記録したもので、`12_テスト戦略.md`「品質ゲート」の
 *    文言もこれに揃えてある
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

/**
 * 欠番のまま残すシナリオID。**監査側で固定する**のが要点で、台帳の
 * `retiredScenarioIds` をそのまま期待集合の除外条件に使うと、台帳を書き換えるだけで
 * 「別のシナリオを退役させて `022` を復活させる」形が22件のまま通ってしまう
 * （台帳は監査対象であって、監査の正本ではない）。台帳側は下でこの定数と
 * 一致することだけを確かめる。
 *
 * `SCN-BTL-022`（未実装Capabilityの拒否）は `REF-023`（Issue #352）がCapability概念
 * ごと廃止したため、検証対象そのものが存在しない。
 */
const RETIRED_SCENARIO_IDS: readonly string[] = ["SCN-BTL-022"];

function scenarioNumber(scenarioId: string): number {
  return Number(scenarioId.slice("SCN-BTL-".length));
}

/**
 * M9の完了時点でCoverageを持たないことを許すルールと、その引き取り先。
 * **監査側で列挙する**のが要点で、「M9以外のOPEN Taskが所有していれば通す」だけの
 * 条件にすると、後から生まれた未被覆ルールが所有者を付けるだけで黙って増えてしまう。
 * ここに無い未被覆ルールは、所有者が居ても落とす。
 *
 * いずれもM9の責務ではなく、Issue #200 の「スコープ変更履歴」が記録した2類型に当たる。
 *
 * - `R-TGT-06`: **部分実装**。前後列優先（`FRONT_ROW`/`BACK_ROW`）は実装済みで
 *   `UT-R-TGT-06-001`〜`003` が回帰検証しているが、同じルールが含む「左右列指定時の
 *   指定列からの列距離順」に production 需要が無く、ルール全体としては完了計上できない
 *   （`rule-coverage.ts` の `R-TGT-06` 注記）。`M7-019`（Issue #273）が「対象を必要と
 *   する production 定義が現れた時点」を着手トリガーとして追跡する
 * - `R-TEX-*`（`TEX-001`／Issue #402、M10）・`R-ENH-*`（`ENH-001`／Issue #409、M11）:
 *   **後続マイルストーンの設計時新設**。Issue #200 起票時のルール集合に含まれない
 *
 * 後続マイルストーンが設計を進めるたびにこの表は伸びる。伸ばすこと自体は正しいが、
 * **伸ばした事実が必ずこの差分に現れる**（＝レビューを通る）ことがこの列挙の目的である。
 */
const RULES_DEFERRED_BEYOND_M9: readonly { readonly ruleId: string; readonly taskId: string }[] = [
  { ruleId: "R-TGT-06", taskId: "M7-019" },
  ...Array.from({ length: 10 }, (_unused, index) => ({
    ruleId: `R-TEX-${String(index + 1).padStart(2, "0")}`,
    taskId: "TEX-001",
  })),
  ...Array.from({ length: 6 }, (_unused, index) => ({
    ruleId: `R-ENH-${String(index + 1).padStart(2, "0")}`,
    taskId: "ENH-001",
  })),
];

describe("M9 completion audit (REL-003)", () => {
  it("UT-AUDIT-M9-001: every baseline scenario M9 committed to exists as an executable test, and the retired ID stays a gap", () => {
    const manifest = readManifest();
    const declared = baselineScenarioIdsFromSpec();

    // 台帳が記録する退役IDは、監査側で固定した集合と一致していなければならない
    // （台帳を書き換えて退役先を差し替える逃げ道を塞ぐ）。
    expect([...manifest.m9Audit.retiredScenarioIds].sort()).toEqual(
      [...RETIRED_SCENARIO_IDS].sort(),
    );

    // 表そのものが監査対象の母数になる。表から消えた／増えたシナリオは
    // 台帳との突き合わせで落ちる。除外は監査側の固定集合だけで行う。
    const retired = new Set(RETIRED_SCENARIO_IDS);
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

    // Coverageを持たないルールは、監査側で列挙した繰り越し分と**完全に一致**して
    // いなければならない。「M9以外のOPEN Taskが所有していれば通す」だけにすると、
    // 後から生まれた未被覆ルールが所有者を付けるだけで黙って増える。
    expect(
      [...uncovered].sort(),
      "rules without executable coverage must be exactly the ones deferred beyond M9",
    ).toEqual([...RULES_DEFERRED_BEYOND_M9.map((entry) => entry.ruleId)].sort());

    // 引き取り先は宣言どおりで、M9以外の実在するOPEN Taskでなければならない
    // （closeしたIssueへ残作業を預けたまま完了扱いにする「所有者不在」を防ぐ。
    // `m7-completion-audit` と同趣旨）。
    for (const { ruleId, taskId } of RULES_DEFERRED_BEYOND_M9) {
      expect(ownerByRuleId.get(ruleId), `${ruleId} must stay assigned to ${taskId}`).toBe(taskId);
      const owner = taskById.get(taskId);
      expect(owner, `${taskId} must be a registered task`).toBeDefined();
      expect(owner!.status, `${taskId} must stay OPEN while it owns ${ruleId}`).toBe("OPEN");
      expect(owner!.milestone, `${taskId} must not be an M9 task`).not.toBe("M9");
    }

    const m9TaskIds = new Set(
      manifest.tasks.filter((task) => task.milestone === "M9").map((task) => task.taskId),
    );
    expect(
      manifest.conversionThemeAssignments
        .filter((assignment) => m9TaskIds.has(assignment.taskId) || assignment.milestone === "M9")
        .map((assignment) => `${assignment.taskId} -> ${assignment.theme}`),
    ).toEqual([]);

    // 繰り越し分は「監査側の列挙」「品質ゲートの根拠」「M9完了記述」の3箇所へ現れる。
    // 後続マイルストーンがルールを増やすと監査側だけが更新されて説明が取り残される
    // （実際にENH-001の取り込みで起きた）ため、設計書側が全件に言及していることを
    // 機械で縛る。範囲表記（`R-TEX-01`〜`10`）で書けるよう、先頭と末尾のIDだけを要求する。
    const documentedRuleMentions: readonly { readonly path: string; readonly label: string }[] = [
      { path: "docs/ddd/12_テスト戦略.md", label: "the quality-gate rationale" },
      { path: "docs/ddd/13_実装計画.md", label: "the REL-003 completion note" },
    ];
    // 範囲表記は先頭IDだけを完全な形で書く（`R-TEX-01`〜`10`）ため、族ごとに
    // **最初の**IDを要求する。
    const mustBeMentioned: string[] = [];
    const seenFamilies = new Set<string>();
    for (const { ruleId } of RULES_DEFERRED_BEYOND_M9) {
      const family = ruleId.slice(0, "R-XXX".length);
      if (!seenFamilies.has(family)) {
        seenFamilies.add(family);
        mustBeMentioned.push(ruleId);
      }
    }
    for (const { path, label } of documentedRuleMentions) {
      const document = readRepositoryFile(path);
      const unmentioned = mustBeMentioned.filter((ruleId) => !document.includes(ruleId));
      expect(
        unmentioned,
        `${label} (${path}) must name every rule family deferred beyond M9`,
      ).toEqual([]);
    }
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
