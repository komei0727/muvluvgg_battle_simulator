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
 * `MEM_FUUKI_IINKAI`（風紀委員会）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `AFF_FUUKI_IINKAI`に所属するキャラクターへ攻撃力+250、陣営全体へ行動速度+12。
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

const MEMORY_DEFINITION_ID = "MEM_FUUKI_IINKAI";

/** 所属メンバーは後衛左の1スロットだけ。 */
const BOARD: MemoryBoardOverrides = {
  affiliationsBySlot: { BACK_LEFT: ["AFF_FUUKI_IINKAI"] },
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
    effectActionDefinitionId: "ACT_MEM_FUUKI_IINKAI_AFFILIATION_ATK_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 250,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_FUUKI_IINKAI_ALL_SPEED_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 12,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_FUUKI_IINKAI (風紀委員会)", () => {
  it("IT-MEM-FUUKI-IINKAI-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 効果1は所属メンバーだけ、効果2は所属に関係なく全員へ乗る。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:BACK_LEFT" ? 250 : 0),
      );
      expect(unit.combatStats.actionSpeed).toBe(MEMORY_COMBAT_STATS.actionSpeed + 12);
    }
  });

  it("IT-MEM-FUUKI-IINKAI-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の後衛左も同じ所属を名乗るが、ENEMY宣言では一切影響を受けない。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-FUUKI-IINKAI-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-FUUKI-IINKAI-004 (R-MEM-01): the affiliation triggeredEffect emits no MemoryTriggered at all when no unit on the board belongs to AFF_FUUKI_IINKAI, while the party-wide one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants).toEqual([
      {
        effectActionDefinitionId: "ACT_MEM_FUUKI_IINKAI_ALL_SPEED_UP",
        unitIds: ALL_ALLY_SLOTS,
        magnitude: 12,
        sourceSide: "ALLY",
      },
    ]);
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack);
      expect(unit.combatStats.actionSpeed).toBe(MEMORY_COMBAT_STATS.actionSpeed + 12);
    }
  });
});
