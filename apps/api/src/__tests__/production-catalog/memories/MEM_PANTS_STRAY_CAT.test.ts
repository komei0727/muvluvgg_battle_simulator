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
 * `MEM_PANTS_STRAY_CAT`（おパンツ咥えたドラネコ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * ENタイプへ攻撃力+1250、ENアタッカーへ防御力+1000。`UNIT_TYPE`と`ROLE`が入れ子に
 * なった集合を選ぶため（ENアタッカーは必ずENタイプだが逆は成り立たない）、
 * 盤面の`BACK_LEFT`だけが両方を受け取る。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_PANTS_STRAY_CAT";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_PANTS_STRAY_CAT_EN_ATTACKER_DEF_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 1000,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PANTS_STRAY_CAT_ENERGY_ATK_UP",
    unitIds: ["ally:FRONT_RIGHT", "ally:BACK_LEFT"],
    magnitude: 1250,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_PANTS_STRAY_CAT (おパンツ咥えたドラネコ)", () => {
  it("IT-MEM-PANTS-STRAY-CAT-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 効果1はENタイプ2体、効果2はそのうちENアタッカー1体だけ。
    for (const unit of observed.started.allyUnits) {
      const isEnergy =
        unit.battleUnitId === "ally:FRONT_RIGHT" || unit.battleUnitId === "ally:BACK_LEFT";
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack + (isEnergy ? 1250 : 0));
      expect(unit.combatStats.defense).toBe(
        MEMORY_COMBAT_STATS.defense + (unit.battleUnitId === "ally:BACK_LEFT" ? 1000 : 0),
      );
    }
  });

  it("IT-MEM-PANTS-STRAY-CAT-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-PANTS-STRAY-CAT-003: every EffectAction this Memory declares was actually executed", () => {
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
