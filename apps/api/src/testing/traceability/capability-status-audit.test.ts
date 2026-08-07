import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectTestCaseDefinitions } from "./test-case-definitions.js";

/**
 * REL-001（Issue #202）が固定する、`IMPLEMENTED` Capability側の監査不変条件。
 *
 * `m7-completion-audit.test.ts`の`UT-AUDIT-M7-002`は未`IMPLEMENTED` Capabilityだけを
 * 検査するため、`IMPLEMENTED`へ移した側の宣言が事実とずれても機械検出されなかった。
 * 実際にREL-001の監査では次の2種類のずれが見つかっている。
 *
 * 1. `CAP_EFFECT_STEP_SET_CONDITION`は`DMG-003`（Issue #196）が production 代表を
 *    揃えて`IMPLEMENTED`へ移したのに、`implementationTaskId`が待機Task`M7-019`
 *    （Issue #273、OPEN）を指したままだった — 完了済みの作業を未着手Taskが
 *    所有しているように読める
 * 2. `IMPLEMENTED`のうち4件（`CAP_ATTACK_DAMAGE_BONUS`／`CAP_RESOURCE_GAIN_MOD`／
 *    `CAP_RESOURCE_MUTATION`／`CAP_SPECIFIC_IMMUNITY`）が、production Catalogを
 *    実経路へ通すテストを1件も証跡に持たず、Domain単体・Schema/Mapperテスト
 *    （`UT-CAT-*`）だけで`IMPLEMENTED`になっていた
 *
 * 2は`14_Catalog定義スキーマ.md`「Schema/Mapperや単体関数だけの完成、fixtureだけの
 * テストでは`IMPLEMENTED`にしない」が禁じている状態そのものであり、これまで人手の
 * レビューでしか守られていなかった。ここではその判定を「証跡test IDのうち少なくとも
 * 1件が`__tests__/production-catalog/`配下で定義されていること」として機械化する
 * （テストID接頭辞`IT-`の有無ではなく定義ファイルの位置で判定する — 接頭辞は
 * 命名規約に過ぎず、実Catalogを読んでいる保証にならない）。
 */

type TaskStatus = "OPEN" | "CLOSED";

interface RemainingWorkTask {
  readonly taskId: string;
  readonly status: TaskStatus;
}

interface CapabilityEntry {
  readonly capabilityId: string;
  readonly runtimeStatus: string;
  readonly implementationTaskId: string;
  readonly verification: {
    readonly productionDefinitionIds: readonly string[];
    readonly testCaseIds: readonly string[];
  };
}

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const apiSrcPath = fileURLToPath(new URL("../../", import.meta.url));
const PRODUCTION_CATALOG_TEST_DIRECTORY = "__tests__/production-catalog/";

/**
 * `17_残作業対応表.json`はM7以降の残作業だけを登録する台帳のため、M6以前に完了した
 * Capabilityの`implementationTaskId`は`tasks`に存在しない。台帳へ遡って登録すると
 * 「残作業の台帳」という位置づけが崩れるため、この2件だけを明示的な例外にする
 * （`UT-AUDIT-M7-002`の同趣旨の除外と対になる）。
 */
const PRE_LEDGER_TASK_IDS: ReadonlySet<string> = new Set(["M6-CD-001", "M6-RC-001"]);

function readTasks(): readonly RemainingWorkTask[] {
  return (
    JSON.parse(readFileSync(`${repositoryRoot}/docs/ddd/17_残作業対応表.json`, "utf8")) as {
      readonly tasks: readonly RemainingWorkTask[];
    }
  ).tasks;
}

function readImplementedCapabilities(): readonly CapabilityEntry[] {
  return (
    JSON.parse(
      readFileSync(`${repositoryRoot}/apps/api/catalog-src/capabilities.json`, "utf8"),
    ) as readonly CapabilityEntry[]
  ).filter((capability) => capability.runtimeStatus === "IMPLEMENTED");
}

describe("Capability status audit (REL-001)", () => {
  it("UT-AUDIT-REL-001-001: every IMPLEMENTED Capability is backed by a production-catalog test", () => {
    const definitions = collectTestCaseDefinitions(apiSrcPath);
    const withoutProductionEvidence = readImplementedCapabilities()
      .filter(
        (capability) =>
          !capability.verification.testCaseIds.some((testCaseId) =>
            (definitions.get(testCaseId) ?? []).some((definition) =>
              definition.file.includes(PRODUCTION_CATALOG_TEST_DIRECTORY),
            ),
          ),
      )
      .map((capability) => capability.capabilityId);

    expect(
      withoutProductionEvidence.sort(),
      "runtimeStatus: IMPLEMENTED requires at least one testCaseId defined under __tests__/production-catalog/; Domain unit tests and Schema/Mapper tests alone are not evidence",
    ).toEqual([]);
  }, 30000);

  it("UT-AUDIT-REL-001-002: every IMPLEMENTED Capability names a task that is already CLOSED", () => {
    const statusByTaskId = new Map(readTasks().map((task) => [task.taskId, task.status]));
    const unsettled = readImplementedCapabilities()
      .filter((capability) => !PRE_LEDGER_TASK_IDS.has(capability.implementationTaskId))
      .filter((capability) => statusByTaskId.get(capability.implementationTaskId) !== "CLOSED")
      .map((capability) => `${capability.capabilityId} -> ${capability.implementationTaskId}`);

    // 実装したPRが同じcommitで自Taskを`CLOSED`にする運用（REL-008／Issue #263ほか）を
    // 前提に、「まだ着手していないTaskが完了済みCapabilityを所有している」状態と
    // 台帳に存在しないTask IDの誤記の両方をここで弾く。
    expect(
      unsettled.sort(),
      "an IMPLEMENTED Capability must name the CLOSED task that made it executable",
    ).toEqual([]);
  });
});
