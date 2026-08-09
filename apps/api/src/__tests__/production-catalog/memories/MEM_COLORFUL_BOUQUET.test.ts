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
 * `MEM_COLORFUL_BOUQUET`（Colorful Bouquet）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `AFF_COLORFUL_BOUQUET`に所属するキャラクターへ攻撃力+250、陣営全体へ攻撃力+250。
 * 2件が同じstatを上げるため、所属メンバーだけが同種の効果を2件保持する。
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

const MEMORY_DEFINITION_ID = "MEM_COLORFUL_BOUQUET";

/** 所属メンバーは前衛右の1スロットだけ。 */
const BOARD: MemoryBoardOverrides = {
  affiliationsBySlot: { FRONT_RIGHT: ["AFF_COLORFUL_BOUQUET"] },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_COLORFUL_BOUQUET_AFFILIATION_ATK_UP",
    unitIds: ["ally:FRONT_RIGHT"],
    magnitude: 250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_COLORFUL_BOUQUET_ALL_ATK_UP",
    unitIds: [
      "ally:FRONT_LEFT",
      "ally:FRONT_CENTER",
      "ally:FRONT_RIGHT",
      "ally:BACK_LEFT",
      "ally:BACK_CENTER",
      "ally:BACK_RIGHT",
    ],
    magnitude: 250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_COLORFUL_BOUQUET (Colorful Bouquet)", () => {
  it("IT-MEM-COLORFUL-BOUQUET-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
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
    // 所属メンバーだけが2件（所属分と全体分）を同時に保持し、実効値へ両方乗る。
    expect(
      observed.started.allyUnits.find((unit) => unit.battleUnitId === "ally:FRONT_RIGHT")
        ?.combatStats.attack,
    ).toBe(MEMORY_COMBAT_STATS.attack + 500);
    expect(
      observed.started.allyUnits.find((unit) => unit.battleUnitId === "ally:FRONT_LEFT")
        ?.combatStats.attack,
    ).toBe(MEMORY_COMBAT_STATS.attack + 250);
  });

  it("IT-MEM-COLORFUL-BOUQUET-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-COLORFUL-BOUQUET-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-COLORFUL-BOUQUET-004 (R-MEM-01): the affiliation triggeredEffect emits no MemoryTriggered at all when no unit on the board belongs to AFF_COLORFUL_BOUQUET, while the party-wide one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants.map((grant) => grant.effectActionDefinitionId)).toEqual([
      "ACT_MEM_COLORFUL_BOUQUET_ALL_ATK_UP",
    ]);
  });
});
