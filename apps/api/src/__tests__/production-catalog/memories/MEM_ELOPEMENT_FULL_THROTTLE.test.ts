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
 * `MEM_ELOPEMENT_FULL_THROTTLE`（駆け落ちフルスロットル！）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `AFF_CHAOS_MAIDEN`に所属するキャラクターへ与ダメージ+2.5%、**敵**後衛へ
 * 行動速度-70。所属フィルタ（自陣営）と`side: "ENEMY"`（相対陣営）が
 * 1つのMemoryに同居する。
 *
 * `AFFILIATION` TargetFilterは静的Catalogの`UnitDefinition.metadata.affiliations`を
 * 引くため、盤面の1スロットだけへ所属を持たせ、残る5スロットがそのまま非対象の
 * 検証になるようにする（`18_Affiliation台帳.md`）。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_ELOPEMENT_FULL_THROTTLE";

/** 所属メンバーは前衛左の1スロットだけ。 */
const BOARD: MemoryBoardOverrides = {
  affiliationsBySlot: { FRONT_LEFT: ["AFF_CHAOS_MAIDEN"] },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_ELOPEMENT_FULL_THROTTLE_AFFILIATION_DMG_UP",
    unitIds: ["ally:FRONT_LEFT"],
    magnitude: 0.025,
    damageMod: { direction: "OUTGOING", damageType: null },
    sourceSide: "ALLY",
  },
  {
    // 対象は敵後衛だが、`sourceSide`はMemoryを宣言した側（ALLY）のまま。
    effectActionDefinitionId: "ACT_MEM_ELOPEMENT_FULL_THROTTLE_ENEMY_BACK_SPEED_DOWN",
    unitIds: ["enemy:BACK_LEFT", "enemy:BACK_CENTER", "enemy:BACK_RIGHT"],
    magnitude: -70,
    statMod: { stat: "ACTION_SPEED", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_ELOPEMENT_FULL_THROTTLE (駆け落ちフルスロットル！)", () => {
  it("IT-MEM-ELOPEMENT-FULL-THROTTLE-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"`（対象と
    // なる陣営全員）が `count: 1` へ退行しても `unitIds` は変わらないため、宣言
    // そのものを固定する。
    expect(observed.targetSelections).toEqual([
      { triggeredEffectIndex: 0, kind: "SELECT", side: "ALLY", count: "ALL" },
      { triggeredEffectIndex: 1, kind: "SELECT", side: "ENEMY", count: "ALL" },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 行動速度の低下は敵後衛だけ。敵前衛と味方後衛は基礎値のまま。
    for (const unit of [...observed.started.allyUnits, ...observed.started.enemyUnits]) {
      expect(unit.combatStats.actionSpeed).toBe(
        MEMORY_COMBAT_STATS.actionSpeed - (unit.battleUnitId.startsWith("enemy:BACK_") ? 70 : 0),
      );
    }
  });

  it("IT-MEM-ELOPEMENT-FULL-THROTTLE-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-ELOPEMENT-FULL-THROTTLE-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-ELOPEMENT-FULL-THROTTLE-004 (R-MEM-01): the affiliation triggeredEffect emits no MemoryTriggered at all when no unit on the board belongs to AFF_CHAOS_MAIDEN, while the enemy-targeting one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants.map((grant) => grant.effectActionDefinitionId)).toEqual([
      "ACT_MEM_ELOPEMENT_FULL_THROTTLE_ENEMY_BACK_SPEED_DOWN",
    ]);
  });
});
