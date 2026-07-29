import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import { loadBattleCatalogDirectory } from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * M7-010（Issue #177、M7完了監査）が固定する監査不変条件。
 *
 * `remaining-work.test.ts`は「件数と割当が台帳・Catalog実データと一致すること」
 * を検証するが、割当先Taskが実際に着手可能かどうかは見ていなかった。その結果、
 * 完了責任を持つIssueがcloseしても残作業だけが台帳へ残り続ける「所有者不在」の
 * 状態が、M7-010時点でRule 3件・不完全変換テーマ4件・Capability 8件に達していた。
 *
 * ここではその再発を防ぐため、次を機械検証する。
 *
 * 1. 残作業の割当先Taskは必ずOPENである（`tasks[].status`）
 * 2. 未`IMPLEMENTED` CapabilityのimplementationTaskIdも必ずOPENである
 * 3. 実在Unit・Memoryのselectabilityと、それを阻むCapabilityの内訳
 *    （ブロック件数と、そのCapability**だけ**が理由になっている排他件数）が
 *    `17_残作業対応表.json`の`m7Audit`の宣言と一致する
 * 4. catalog-srcのどの定義からも`requiredCapabilities`で宣言されていない
 *    Capabilityの集合が、`m7Audit.unreferencedCapabilities`の宣言と一致する
 *
 * 4はM7-010の実監査で、`CAP_RESOURCE_CAPACITY_MOD`の説明が
 * 「現行のCatalog変換行のどれからも参照されておらず」と記述しているにも
 * かかわらず`UNIT_FLUTE_VAMPIRE`が実際には参照していたことを検出したため、
 * 同じ形の事実誤りを二度と持ち込めないようにする。
 */

type TaskStatus = "OPEN" | "CLOSED";

interface RemainingWorkTask {
  readonly taskId: string;
  readonly issue: number;
  readonly phase: number;
  readonly milestone: string;
  readonly status: TaskStatus;
}

interface BlockingCapability {
  readonly capabilityId: string;
  readonly blockedUnits: number;
  readonly blockedMemories: number;
  /** そのCapabilityだけが非selectableの理由になっている件数（実装完了で即selectableになる件数）。 */
  readonly exclusivelyBlockedUnits: number;
  readonly exclusivelyBlockedMemories: number;
}

interface M7AuditManifest {
  readonly tasks: readonly RemainingWorkTask[];
  readonly ruleAssignments: readonly { readonly taskId: string }[];
  readonly conversionThemeAssignments: readonly { readonly taskId: string }[];
  readonly unconvertedMemoryAssignments: readonly { readonly taskId: string }[];
  readonly m7Audit: {
    readonly auditDate: string;
    readonly auditIssue: number;
    readonly selectability: {
      readonly productionUnits: number;
      readonly selectableProductionUnits: number;
      readonly syntheticUnits: number;
      readonly selectableSyntheticUnits: number;
      readonly memories: number;
      readonly selectableMemories: number;
    };
    readonly blockingCapabilities: readonly BlockingCapability[];
    readonly unreferencedCapabilities: readonly string[];
  };
}

interface CapabilityEntry {
  readonly capabilityId: string;
  readonly runtimeStatus: string;
  readonly implementationTaskId: string;
}

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const catalogSrcPath = `${repositoryRoot}/apps/api/catalog-src`;
const catalogPath = `${repositoryRoot}/apps/api/catalog`;

function readManifest(): M7AuditManifest {
  return JSON.parse(
    readFileSync(`${repositoryRoot}/docs/ddd/17_残作業対応表.json`, "utf8"),
  ) as M7AuditManifest;
}

function readCapabilities(): readonly CapabilityEntry[] {
  return JSON.parse(
    readFileSync(`${catalogSrcPath}/capabilities.json`, "utf8"),
  ) as readonly CapabilityEntry[];
}

/** catalog-src全体を走査し、`requiredCapabilities`で宣言されたCapability IDを数える。 */
function countCapabilityDeclarations(): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const group of ["units", "memories"] as const) {
    const groupPath = `${catalogSrcPath}/${group}`;
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      for (const fileName of readdirSync(`${groupPath}/${entry.name}`)) {
        if (!fileName.endsWith(".json")) {
          continue;
        }
        const parsed: unknown = JSON.parse(
          readFileSync(`${groupPath}/${entry.name}/${fileName}`, "utf8"),
        );
        const definitions = Array.isArray(parsed) ? parsed : [parsed];
        for (const definition of definitions) {
          const declared = (definition as { requiredCapabilities?: readonly string[] })
            .requiredCapabilities;
          for (const capabilityId of declared ?? []) {
            counts.set(capabilityId, (counts.get(capabilityId) ?? 0) + 1);
          }
        }
      }
    }
  }
  return counts;
}

const SYNTHETIC_UNIT_ID = "UNIT_CI_SMOKE_TEST";

function projectCatalog(): ReturnType<GetBattleSimulationCatalogUseCase["execute"]> {
  return new GetBattleSimulationCatalogUseCase({
    battleCatalogDirectory: loadBattleCatalogDirectory(catalogPath),
  }).execute();
}

describe("M7 completion audit (M7-010)", () => {
  it("UT-AUDIT-M7-001: assigns every remaining rule, conversion theme, and Memory to an OPEN task", () => {
    const manifest = readManifest();
    const taskById = new Map(manifest.tasks.map((task) => [task.taskId, task]));

    expect(manifest.tasks.every((task) => task.status === "OPEN" || task.status === "CLOSED")).toBe(
      true,
    );

    const orphaned = [
      ...manifest.ruleAssignments,
      ...manifest.conversionThemeAssignments,
      ...manifest.unconvertedMemoryAssignments,
    ]
      .map((assignment) => assignment.taskId)
      .filter((taskId) => taskById.get(taskId)?.status !== "OPEN");

    expect(
      [...new Set(orphaned)].sort(),
      "remaining work must be owned by an OPEN task; reassign it before closing the owner",
    ).toEqual([]);
  });

  it("UT-AUDIT-M7-002: assigns every unimplemented Capability to an OPEN task", () => {
    const manifest = readManifest();
    const taskById = new Map(manifest.tasks.map((task) => [task.taskId, task]));
    const orphaned = readCapabilities()
      .filter((capability) => capability.runtimeStatus !== "IMPLEMENTED")
      .filter((capability) => taskById.get(capability.implementationTaskId)?.status !== "OPEN")
      .map((capability) => `${capability.capabilityId} -> ${capability.implementationTaskId}`);

    // `IMPLEMENTED`側は対象外にする。`17_残作業対応表.json`はM7以降の残作業だけを
    // 登録する台帳であり、M6以前に完了したCapability（`CAP_COOLDOWN_MANIPULATION`の
    // `M6-CD-001`、`CAP_SKILL_RUNTIME_COUNTER`の`M6-RC-001`）は`tasks`へ登録されない。
    expect(
      orphaned.sort(),
      "unimplemented Capabilities must name an OPEN implementation task",
    ).toEqual([]);
  });

  it("UT-AUDIT-M7-003: records the real-Unit and Memory selectability reached at M7", () => {
    const manifest = readManifest();
    const result = projectCatalog();
    const productionUnits = result.units.filter(
      (unit) => unit.unitDefinitionId !== SYNTHETIC_UNIT_ID,
    );
    const syntheticUnits = result.units.filter(
      (unit) => unit.unitDefinitionId === SYNTHETIC_UNIT_ID,
    );

    expect({
      productionUnits: productionUnits.length,
      selectableProductionUnits: productionUnits.filter((unit) => unit.selectable).length,
      syntheticUnits: syntheticUnits.length,
      selectableSyntheticUnits: syntheticUnits.filter((unit) => unit.selectable).length,
      memories: result.memories.length,
      selectableMemories: result.memories.filter((memory) => memory.selectable).length,
    }).toEqual(manifest.m7Audit.selectability);
  });

  it("UT-AUDIT-M7-004: records exactly which Capabilities still block selection", () => {
    const manifest = readManifest();
    const result = projectCatalog();
    type Counts = Omit<BlockingCapability, "capabilityId">;
    const blocked = new Map<string, Counts>();
    const bump = (capabilityId: string, key: keyof Counts): void => {
      const entry = blocked.get(capabilityId) ?? {
        blockedUnits: 0,
        blockedMemories: 0,
        exclusivelyBlockedUnits: 0,
        exclusivelyBlockedMemories: 0,
      };
      blocked.set(capabilityId, { ...entry, [key]: entry[key] + 1 });
    };
    for (const unit of result.units) {
      for (const capabilityId of unit.unavailableCapabilities) {
        bump(capabilityId, "blockedUnits");
        if (unit.unavailableCapabilities.length === 1) {
          bump(capabilityId, "exclusivelyBlockedUnits");
        }
      }
    }
    for (const memory of result.memories) {
      for (const capabilityId of memory.unavailableCapabilities) {
        bump(capabilityId, "blockedMemories");
        if (memory.unavailableCapabilities.length === 1) {
          bump(capabilityId, "exclusivelyBlockedMemories");
        }
      }
    }

    const actual: BlockingCapability[] = [...blocked.entries()]
      .map(([capabilityId, counts]) => ({ capabilityId, ...counts }))
      .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));

    expect(actual).toEqual(
      [...manifest.m7Audit.blockingCapabilities].sort((a, b) =>
        a.capabilityId.localeCompare(b.capabilityId),
      ),
    );
  });

  it("UT-AUDIT-M7-005: records exactly which Capabilities no production definition declares", () => {
    const manifest = readManifest();
    const declarationCounts = countCapabilityDeclarations();
    const unreferenced = readCapabilities()
      .filter((capability) => (declarationCounts.get(capability.capabilityId) ?? 0) === 0)
      .map((capability) => capability.capabilityId)
      .sort();

    // 「production定義から参照されていない」ことを理由に着手を見送る運用
    // （#255 / M7-002A、M7-019）は、この一覧が実データと一致している限りでのみ
    // 正当である。M7-010の実監査では`CAP_RESOURCE_CAPACITY_MOD`が
    // 「現行のCatalog変換行のどれからも参照されていない」と記録されながら
    // `UNIT_FLUTE_VAMPIRE`から実際に参照されていた。
    expect(
      unreferenced,
      "the recorded set of Capabilities that no production definition declares must match catalog-src",
    ).toEqual([...manifest.m7Audit.unreferencedCapabilities].sort());
  });
});
