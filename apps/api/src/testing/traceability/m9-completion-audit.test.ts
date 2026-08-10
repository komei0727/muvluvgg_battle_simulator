import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

/**
 * `REL-003`（Issue #200、M9リリース承認）が固定する監査不変条件。
 *
 * `m8-completion-audit.test.ts` が「M8という完了境界」を機械化したのと同じ形で、
 * ここは**M9のリリース証跡そのもの**を機械化する。証跡が文章だけで残っていると、
 * 後からシナリオが消えても・M9が引き受けた責務が戻ってきても・出荷したCatalogが
 * 別物になっても誰も気づけない。
 *
 * **ここに置くのはM9固有の不変条件だけにする。** 「未被覆ルールが所有者を持つ」
 * ような**現在進行形の品質ゲート**をここへ混ぜると、M10・M11が新しいルールを足す
 * たびに過去の完了監査が壊れ、M9と無関係な変更が本ファイルとIssue #200の完了根拠の
 * 更新を要求する（`ENH-001` の取り込みで実際に起きた）。継続的な検査は
 * `remaining-work.test.ts` の `UT-PLAN-001-*`（機械可読な台帳を正本とする）が持つ。
 *
 * ここで機械検証するのは次の4点である。
 *
 * 1. M9が検証した主要22シナリオが、リポジトリに実行対象のテストとして実在する
 * 2. 退役した `SCN-BTL-022` が欠番のまま（テストが復活していない）
 * 3. M9 Taskが未完了Rule・不完全変換行を1件も所有していない
 * 4. release証跡として記録した `catalogRevision` が、実際に出荷する
 *    `catalog/manifest.json` と一致する
 */

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));

interface M9AuditManifest {
  readonly tasks: readonly {
    readonly taskId: string;
    readonly milestone: string;
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
 * M9が検証した主要22シナリオ。`13_実装計画.md`「M9 完成・性能・リリース準備」が
 * 「`SCN-BTL-001`〜`023` のうち退役分を除く22件」と定めた集合を**監査側で凍結する**。
 *
 * 台帳の `m9Audit.scenarioIds` をそのまま使わないのは、台帳が監査対象であって監査の
 * 正本ではないためである（台帳を書き換えるだけで母数を動かせてしまう）。逆に
 * `12_テスト戦略.md` の基準シナリオ表から読むこともしない — M10以降が表へ行を足す
 * たびに過去のM9証跡の母数が動く形になり、この監査を凍結できなくなる。
 */
const M9_SCENARIO_IDS: readonly string[] = Array.from(
  { length: 23 },
  (_unused, index) => `SCN-BTL-${String(index + 1).padStart(3, "0")}`,
).filter((scenarioId) => scenarioId !== "SCN-BTL-022");

/**
 * 欠番のまま残すシナリオID。`SCN-BTL-022`（未実装Capabilityの拒否）は
 * `REF-023`（Issue #352）がCapability概念ごと廃止したため、検証対象そのものが存在しない。
 */
const RETIRED_SCENARIO_IDS: readonly string[] = ["SCN-BTL-022"];

describe("M9 completion audit (REL-003)", () => {
  it("UT-AUDIT-M9-001: every scenario M9 verified exists as an executable test, and the retired ID stays a gap", () => {
    const manifest = readManifest();

    // 台帳が記録するrelease証跡は、監査側で凍結した集合と一致していなければならない。
    expect(M9_SCENARIO_IDS).toHaveLength(22);
    expect([...manifest.m9Audit.scenarioIds].sort()).toEqual([...M9_SCENARIO_IDS].sort());
    expect([...manifest.m9Audit.retiredScenarioIds].sort()).toEqual(
      [...RETIRED_SCENARIO_IDS].sort(),
    );

    // 実行対象のテストとして実在すること。`it.skip`/`todo`/条件付き無効化・
    // コメント内・文字列内は `collectTestCaseDefinitions` が除いている。
    const definitions = collectTestCaseDefinitions(apiSrcPath);
    const missing = M9_SCENARIO_IDS.filter(
      (scenarioId) => (definitions.get(scenarioId) ?? []).length === 0,
    );
    expect(
      missing,
      `scenarios M9 verified but that no longer have an executable test: ${JSON.stringify(missing)}`,
    ).toEqual([]);

    // 退役IDのテストが復活していないこと（欠番の実効性）。
    for (const scenarioId of RETIRED_SCENARIO_IDS) {
      expect(definitions.get(scenarioId) ?? []).toEqual([]);
    }
    // `collectTestCaseDefinitions` は src 全体を走査するため、coverage計測下では
    // 既定の5秒に収まらない（`UT-TRACEABILITY-005` と同じ理由・同じ猶予）。
  }, 30000);

  it("UT-AUDIT-M9-002: no M9 task still owns an uncompleted rule or an incomplete conversion row", () => {
    const manifest = readManifest();
    const m9TaskIds = new Set(
      manifest.tasks.filter((task) => task.milestone === "M9").map((task) => task.taskId),
    );

    // M9の完了は「M9が引き受けた責務を全部果たした」ことである。**他マイルストーンが
    // 何件の未被覆ルールを持っているかはM9の完了境界と関係ない** — そちらは
    // `remaining-work.test.ts` の継続的な検査が見る（`UT-PLAN-001-001`／`009`）。
    const rules = manifest.ruleAssignments
      .filter((assignment) => m9TaskIds.has(assignment.taskId))
      .flatMap((assignment) =>
        assignment.ruleIds.map((ruleId) => `${assignment.taskId} -> ${ruleId}`),
      );
    expect(rules, "M9 is complete only when no M9 task owns a remaining rule").toEqual([]);

    const rows = manifest.conversionThemeAssignments
      .filter((assignment) => m9TaskIds.has(assignment.taskId) || assignment.milestone === "M9")
      .map((assignment) => `${assignment.taskId} -> ${assignment.theme}`);
    expect(rows, "M9 is complete only when no incomplete conversion row is assigned to M9").toEqual(
      [],
    );
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
