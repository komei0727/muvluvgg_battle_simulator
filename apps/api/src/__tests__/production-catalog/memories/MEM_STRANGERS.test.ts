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
 * `MEM_STRANGERS`（STRANGERS）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 陣営全体へ行動速度+30と会心率+1%。会心率側は`valueType: RATIO`（基礎値に対する
 * 割合）で、行動速度側は`FIXED`。同じ集合へ2つの`valueType`が並ぶ唯一の組み合わせ。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_STRANGERS";

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
    effectActionDefinitionId: "ACT_MEM_STRANGERS_ALL_CRIT_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 0.01,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_STRANGERS_ALL_SPEED_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 30,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_STRANGERS (STRANGERS)", () => {
  it("IT-MEM-STRANGERS-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.actionSpeed).toBe(MEMORY_COMBAT_STATS.actionSpeed + 30);
      // 会心率は`RATIO`のため基礎値へ比例する。盤面の基礎会心率は0で、
      // 効果は適用されるが実効値は動かない。
      expect(unit.combatStats.criticalRate).toBe(MEMORY_COMBAT_STATS.criticalRate * 1.01);
    }
  });

  it("IT-MEM-STRANGERS-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-STRANGERS-003: every EffectAction this Memory declares was actually executed", () => {
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
