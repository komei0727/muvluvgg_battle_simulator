import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  MEMORY_COMBAT_STATS,
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemory,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_NEW_YEAR_GREETING`（新年のご挨拶）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 陣営全体へEN与ダメージ+1.75%と攻撃力+250。絞り込みを一切持たない2件で構成される。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_NEW_YEAR_GREETING";

const ALL_ALLY_SLOTS = [
  "ally:FRONT_LEFT",
  "ally:FRONT_CENTER",
  "ally:FRONT_RIGHT",
  "ally:BACK_LEFT",
  "ally:BACK_CENTER",
  "ally:BACK_RIGHT",
];

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_NEW_YEAR_GREETING_ALL_ATK_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 250,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_NEW_YEAR_GREETING_ALL_EN_DMG_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 0.0175,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_NEW_YEAR_GREETING (新年のご挨拶)", () => {
  it("IT-MEM-NEW-YEAR-GREETING-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    // 表はEffectAction ID順のため、定義順（EN与ダメージ → 攻撃力）とは並びが異なる。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack + 250);
    }
  });

  it("IT-MEM-NEW-YEAR-GREETING-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-NEW-YEAR-GREETING-003: every EffectAction this Memory declares was actually executed", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY").executedActionIds),
      ),
    ).toEqual([]);
  });
});
