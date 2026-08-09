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
 * `MEM_TREBLE_QUINTET`（Treble Quintet）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `AFF_TREBLE_QUINTET`に所属するキャラクターへ攻撃力+250、陣営全体へ会心率+1%。
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

const MEMORY_DEFINITION_ID = "MEM_TREBLE_QUINTET";

/** 所属メンバーは後衛右の1スロットだけ。 */
const BOARD: MemoryBoardOverrides = {
  affiliationsBySlot: { BACK_RIGHT: ["AFF_TREBLE_QUINTET"] },
};

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
    effectActionDefinitionId: "ACT_MEM_TREBLE_QUINTET_AFFILIATION_ATK_UP",
    unitIds: ["ally:BACK_RIGHT"],
    magnitude: 250,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_TREBLE_QUINTET_ALL_CRIT_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 0.01,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_TREBLE_QUINTET (Treble Quintet)", () => {
  it("IT-MEM-TREBLE-QUINTET-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 効果1は所属メンバーだけ、効果2は所属に関係なく全員へ乗る。会心率は`RATIO`の
    // ため基礎値へ比例し、盤面の基礎会心率0では実効値が動かない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:BACK_RIGHT" ? 250 : 0),
      );
      expect(unit.combatStats.criticalRate).toBe(MEMORY_COMBAT_STATS.criticalRate * 1.01);
    }
  });

  it("IT-MEM-TREBLE-QUINTET-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の後衛右も同じ所属を名乗るが、ENEMY宣言では一切影響を受けない。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-TREBLE-QUINTET-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-TREBLE-QUINTET-004 (R-MEM-01): the affiliation triggeredEffect emits no MemoryTriggered at all when no unit on the board belongs to AFF_TREBLE_QUINTET, while the party-wide one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants.map((grant) => grant.effectActionDefinitionId)).toEqual([
      "ACT_MEM_TREBLE_QUINTET_ALL_CRIT_UP",
    ]);
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack);
    }
  });
});
