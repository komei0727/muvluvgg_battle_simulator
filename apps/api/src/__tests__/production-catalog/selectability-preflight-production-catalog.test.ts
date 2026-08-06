import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GetBattleSimulationCatalogUseCase } from "../../application/catalog/get-battle-simulation-catalog-use-case.js";
import { runPreflight } from "../../application/simulation/simulation-preflight-validator.js";
import { ApplicationError } from "../../application/contracts/application-error.js";
import type {
  FormationInput,
  SimulateBattleCommand,
} from "../../application/simulation/simulate-battle-command.js";
import type {
  CapabilityId,
  MemoryDefinitionId,
  UnitDefinitionId,
} from "../../domain/catalog/definitions/catalog-ids.js";
import type { BattleCatalogSnapshot } from "../../domain/ports/battle-catalog.js";
import type { BattleCatalogDirectory } from "../../domain/ports/battle-catalog-directory.js";
import {
  loadBattleCatalogDirectory,
  loadCatalogFromDirectory,
} from "../../infrastructure/catalog/runtime/catalog-file-loader.js";

/**
 * REL-001（Issue #202）: 「Catalog一覧のselectabilityとpreflightを一致させる」。
 *
 * 両者は`collectRequiredCapabilities`／`findUnimplementedCapabilities`という同じ
 * 関数を共有しているが、**呼び出し方が違う** — 一覧は1定義ずつprojectionし、
 * preflightは編成全体を1回で判定する。共有しているのは実装であって契約ではない
 * ため、「一覧でselectableと出したUnit/Memoryだけで組んだ編成が、実
 * `catalog/`でBattle生成前に`UNSUPPORTED_RULE`で弾かれない」ことは別途固定する
 * 必要がある。UIは一覧のselectabilityだけを見て編成を組ませるので、ここがずれると
 * 「選べたのに実行できない編成」がproductionで成立してしまう。
 *
 * ここでは実`catalog/`に対して次を機械検証する。
 *
 * 1. selectableな実在Unit・Memoryを全件入れた編成がpreflightを通過する（両陣営）
 * 2. 非selectableな定義を含む編成は必ず`UNSUPPORTED_RULE`になり、そのviolationが
 *    名指しするCapability IDの集合が、一覧の`unavailableCapabilities`と一致する
 *
 * 2は現在の実`catalog/`にはCapability不足の定義が1件も無い（実在Unit 69件・
 * Memory 32件がすべてselectable）ため、実Catalogのまま流すとvacuousになる。
 * 一覧とpreflightは同じsnapshotの`capabilities`を読むので、ロード済みsnapshotの
 * Capability 1件だけを`PLANNED`へ倒して両者へ同時に効かせ、production定義には
 * 一切手を触れずに不一致を検出できる形にする。
 */

const CATALOG_DIR = fileURLToPath(new URL("../../../catalog", import.meta.url));

function directoryOf(snapshot: BattleCatalogSnapshot): BattleCatalogDirectory {
  return { loadSnapshot: () => snapshot };
}

function formationOf(
  unitDefinitionIds: readonly UnitDefinitionId[],
  memoryDefinitionIds: readonly MemoryDefinitionId[],
): FormationInput {
  return {
    // preflightは参照解決とCapability判定だけを行い、スロット数・座標重複の
    // 検証は`validateCommandShape`が別途担うため、ここでは全件を一度に入れる。
    slots: unitDefinitionIds.map((unitDefinitionId) => ({
      unitDefinitionId,
      position: { column: 1, row: "FRONT" },
    })),
    memoryDefinitionIds,
  };
}

function commandOf(formation: FormationInput): SimulateBattleCommand {
  return {
    allyFormation: formation,
    enemyFormation: formation,
    turnLimit: 1,
    logLevel: "SUMMARY",
  };
}

/**
 * 実`catalog/`をロードし、`capabilityId`だけを`PLANNED`へ倒したsnapshotを返す。
 * 一覧・preflightのどちらも同じ`snapshot.capabilities`を読むため、両者を同時に
 * 同じ前提へ置ける（production定義そのものは無改変）。
 */
function snapshotWithPlannedCapability(capabilityId: CapabilityId): BattleCatalogSnapshot {
  const snapshot = loadBattleCatalogDirectory(CATALOG_DIR).loadSnapshot();
  const capability = snapshot.capabilities.get(capabilityId)!;
  return {
    ...snapshot,
    capabilities: new Map(snapshot.capabilities).set(capabilityId, {
      ...capability,
      runtimeStatus: "PLANNED",
    }),
  };
}

describe("production Catalog selectability vs preflight (REL-001, Issue #202, R-FRM-06)", () => {
  it("IT-REL-001-SELECTABILITY-PREFLIGHT-001: a formation built from every selectable production Unit and Memory passes the real preflight", () => {
    const snapshot = loadBattleCatalogDirectory(CATALOG_DIR).loadSnapshot();
    const listing = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: directoryOf(snapshot),
    }).execute();

    const selectableUnits = listing.units
      .filter((unit) => unit.selectable)
      .map((unit) => unit.unitDefinitionId);
    const selectableMemories = listing.memories
      .filter((memory) => memory.selectable)
      .map((memory) => memory.memoryDefinitionId);

    // 一覧が「選べる」と言った定義が実際に1件以上あることを前提として固定する
    // （全件非selectableでも素通りする空虚な検証にしない）。
    expect(selectableUnits.length).toBeGreaterThan(0);
    expect(selectableMemories.length).toBeGreaterThan(0);

    expect(() =>
      runPreflight(
        commandOf(formationOf(selectableUnits, selectableMemories)),
        loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot(selectableUnits, selectableMemories),
      ),
    ).not.toThrow();
  });

  it("IT-REL-001-SELECTABILITY-PREFLIGHT-002: each selectable production definition passes the real preflight on its own, so the per-definition projection is honest", () => {
    const snapshot = loadBattleCatalogDirectory(CATALOG_DIR).loadSnapshot();
    const listing = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: directoryOf(snapshot),
    }).execute();

    const rejected: string[] = [];
    for (const unit of listing.units.filter((entry) => entry.selectable)) {
      try {
        runPreflight(
          commandOf(formationOf([unit.unitDefinitionId], [])),
          loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot([unit.unitDefinitionId], []),
        );
      } catch {
        rejected.push(unit.unitDefinitionId);
      }
    }
    for (const memory of listing.memories.filter((entry) => entry.selectable)) {
      try {
        runPreflight(
          commandOf(formationOf([], [memory.memoryDefinitionId])),
          loadCatalogFromDirectory(CATALOG_DIR).loadSnapshot([], [memory.memoryDefinitionId]),
        );
      } catch {
        rejected.push(memory.memoryDefinitionId);
      }
    }

    expect(
      rejected.sort(),
      "the catalog listing must not mark a definition selectable that preflight then refuses",
    ).toEqual([]);
  }, 30000);

  it("IT-REL-001-SELECTABILITY-PREFLIGHT-003: when a Capability is not IMPLEMENTED, the listing's unavailableCapabilities and preflight's UNSUPPORTED_RULE violations name exactly the same Capability IDs", () => {
    // 実`catalog/`で最も多くの定義が要求するCapabilityの1件。どれを倒しても
    // 一覧とpreflightは同じ判定に従うはずである。
    const capabilityId = "CAP_STAT_MOD" as CapabilityId;
    const snapshot = snapshotWithPlannedCapability(capabilityId);
    const listing = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: directoryOf(snapshot),
    }).execute();

    const blockedUnits = listing.units.filter((unit) => !unit.selectable);
    const blockedMemories = listing.memories.filter((memory) => !memory.selectable);
    expect(blockedUnits.length).toBeGreaterThan(0);
    for (const unit of blockedUnits) {
      expect(unit.unavailableCapabilities).toContain(capabilityId);
    }

    const command = commandOf(
      formationOf(
        blockedUnits.map((unit) => unit.unitDefinitionId),
        blockedMemories.map((memory) => memory.memoryDefinitionId),
      ),
    );
    let error: unknown;
    try {
      runPreflight(command, snapshot);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(ApplicationError);
    const applicationError = error as ApplicationError;
    expect(applicationError.code).toBe("UNSUPPORTED_RULE");
    const namedCapabilityIds = [
      ...new Set(applicationError.violations.map((violation) => violation.ruleId)),
    ].sort();
    const listedCapabilityIds = [
      ...new Set([
        ...blockedUnits.flatMap((unit) => unit.unavailableCapabilities),
        ...blockedMemories.flatMap((memory) => memory.unavailableCapabilities),
      ]),
    ].sort();

    expect(namedCapabilityIds).toEqual(listedCapabilityIds);
  });

  it("IT-REL-001-SELECTABILITY-PREFLIGHT-004: a definition the listing still marks selectable under the same downgrade is still accepted by preflight", () => {
    const capabilityId = "CAP_STAT_MOD" as CapabilityId;
    const snapshot = snapshotWithPlannedCapability(capabilityId);
    const listing = new GetBattleSimulationCatalogUseCase({
      battleCatalogDirectory: directoryOf(snapshot),
    }).execute();

    const stillSelectable = listing.units
      .filter((unit) => unit.selectable)
      .map((unit) => unit.unitDefinitionId);
    // 片側だけが厳しくなる（一覧は通すのにpreflightが弾く）ずれをここで弾く。
    expect(stillSelectable.length).toBeGreaterThan(0);
    expect(() => runPreflight(commandOf(formationOf(stillSelectable, [])), snapshot)).not.toThrow();
  });
});
