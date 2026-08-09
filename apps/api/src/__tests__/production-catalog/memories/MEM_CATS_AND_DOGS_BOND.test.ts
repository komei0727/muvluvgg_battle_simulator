import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemory,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_CATS_AND_DOGS_BOND`（腐れ縁で犬猿の仲？）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 前衛へ物理与ダメージ+3%とHP+1500。同じ前衛集合を2つの`triggeredEffect`が別々に選ぶ。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_CATS_AND_DOGS_BOND";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_CATS_AND_DOGS_BOND_FRONT_HP_UP",
    unitIds: ["ally:FRONT_LEFT", "ally:FRONT_CENTER", "ally:FRONT_RIGHT"],
    magnitude: 1500,
    statMod: { stat: "MAXIMUM_HP", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_CATS_AND_DOGS_BOND_FRONT_PHYSICAL_DMG_UP",
    unitIds: ["ally:FRONT_LEFT", "ally:FRONT_CENTER", "ally:FRONT_RIGHT"],
    magnitude: 0.03,
    damageMod: { direction: "OUTGOING", damageType: "PHYSICAL" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_CATS_AND_DOGS_BOND (腐れ縁で犬猿の仲？)", () => {
  it("IT-MEM-CATS-AND-DOGS-BOND-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"`（対象と
    // なる陣営全員）が `count: 1` へ退行しても `unitIds` は変わらないため、宣言
    // そのものを固定する。
    expect(observed.targetSelections).toEqual([
      { triggeredEffectIndex: 0, kind: "SELECT", side: "ALLY", count: "ALL" },
      { triggeredEffectIndex: 1, kind: "SELECT", side: "ALLY", count: "ALL" },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
  });

  it("IT-MEM-CATS-AND-DOGS-BOND-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-CATS-AND-DOGS-BOND-003: every EffectAction this Memory declares was actually executed", () => {
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
