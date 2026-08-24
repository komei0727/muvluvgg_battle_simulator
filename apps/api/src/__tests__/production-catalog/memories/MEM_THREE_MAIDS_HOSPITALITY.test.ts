import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  MEMORY_COMBAT_STATS,
  type MemoryBoardOverrides,
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeMemory,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_THREE_MAIDS_HOSPITALITY`（メイド３人のおもてなし？）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * キュート属性へ与ダメージ+2.5%、スマート属性へ攻撃力+1250。`ATTRIBUTE`
 * TargetFilterを使う定義（ほかに `MEM_LIKE_FRIENDS`・`MEM_GIDDY_CIRCUMSTANCES`）。
 *
 * `ATTRIBUTE`は`UnitDefinition`ではなく編成時に決まる`BattleUnit.attribute`を読むため、
 * 盤面の2スロットだけへ対象属性を持たせ、残る4スロット（既定の`AGGRESSIVE`）が
 * そのまま非対象の検証になるようにする。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_THREE_MAIDS_HOSPITALITY";

/** 対象属性は前衛左（キュート）と後衛右（スマート）の2スロットだけ。 */
const BOARD: MemoryBoardOverrides = {
  attributesBySlot: { FRONT_LEFT: "CUTE", BACK_RIGHT: "SMART" },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_THREE_MAIDS_HOSPITALITY_CUTE_DMG_UP",
    unitIds: ["ally:FRONT_LEFT"],
    magnitude: 0.025,
    damageMod: { direction: "OUTGOING", damageType: null },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_THREE_MAIDS_HOSPITALITY_SMART_ATK_UP",
    unitIds: ["ally:BACK_RIGHT"],
    magnitude: 1250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_THREE_MAIDS_HOSPITALITY (メイド３人のおもてなし？)", () => {
  it("IT-MEM-THREE-MAIDS-HOSPITALITY-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
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
        filters: [{ kind: "ATTRIBUTE", attribute: "CUTE" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ATTRIBUTE", attribute: "SMART" }],
      },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。`grants`はID順、
    // `markers`は別配列なので適用順を表さないが、順序が入れ替わると
    // `EffectApplied`／`MarkerApplied`の発行順が変わり、それを契機にする連鎖が変わる。
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 0, actionIds: ["ACT_MEM_THREE_MAIDS_HOSPITALITY_CUTE_DMG_UP"] },
      { triggeredEffectIndex: 1, actionIds: ["ACT_MEM_THREE_MAIDS_HOSPITALITY_SMART_ATK_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 攻撃力の上昇はスマート属性の1体だけ。キュート属性側は与ダメージ補正なので
    // 能力値は動かない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:BACK_RIGHT" ? 1250 : 0),
      );
    }
  });

  it("IT-MEM-THREE-MAIDS-HOSPITALITY-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の同じスロットも同じ属性を持つが、ENEMY宣言では一切影響を受けない。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-THREE-MAIDS-HOSPITALITY-003: every EffectAction this Memory declares was actually executed", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD).executedActionIds),
      ),
    ).toEqual([]);
  });

  it("IT-MEM-THREE-MAIDS-HOSPITALITY-004 [R-MEM-01] (R-MEM-01): neither triggeredEffect emits MemoryTriggered when no ally carries CUTE or SMART", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。この Memory は
    // 2件とも属性で絞るため、既定の`AGGRESSIVE`だけの盤面では1件も発動しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([]);
    expect(observed.grants).toEqual([]);
  });
});
