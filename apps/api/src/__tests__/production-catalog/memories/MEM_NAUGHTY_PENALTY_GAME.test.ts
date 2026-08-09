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
 * `MEM_NAUGHTY_PENALTY_GAME`（エッ◯な罰ゲームやってみた）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * コントロールへ物理与ダメージ+3.5%、タンクへ防御力+1000。2つの`triggeredEffect`が
 * ROLEで互いに素な集合を選ぶ。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_NAUGHTY_PENALTY_GAME";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_NAUGHTY_PENALTY_GAME_CONTROL_PHYSICAL_DMG_UP",
    unitIds: ["ally:BACK_RIGHT"],
    magnitude: 0.035,
    damageMod: { direction: "OUTGOING", damageType: "PHYSICAL" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_NAUGHTY_PENALTY_GAME_TANK_DEF_UP",
    unitIds: ["ally:FRONT_CENTER"],
    magnitude: 1000,
    statMod: { stat: "DEFENSE", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_NAUGHTY_PENALTY_GAME (エッ◯な罰ゲームやってみた)", () => {
  it("IT-MEM-NAUGHTY-PENALTY-GAME-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"`（対象と
    // なる陣営全員）が `count: 1` へ退行しても、絞り込みを同じ1体を引く別の
    // `filters` へ差し替えても `unitIds` は変わらない。宣言そのものを固定する。
    expect(observed.targetSelections).toEqual([
      {
        triggeredEffectIndex: 0,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ROLE", role: "CONTROL" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ROLE", role: "TANK" }],
      },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 防御力の上昇はタンク（前衛中央）だけに乗る。ROLEフィルタが行・列と相関して
    // いないため、位置で絞れているだけという偽陽性は成立しない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.defense).toBe(
        MEMORY_COMBAT_STATS.defense + (unit.battleUnitId === "ally:FRONT_CENTER" ? 1000 : 0),
      );
    }
  });

  it("IT-MEM-NAUGHTY-PENALTY-GAME-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-NAUGHTY-PENALTY-GAME-003: every EffectAction this Memory declares was actually executed", () => {
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
