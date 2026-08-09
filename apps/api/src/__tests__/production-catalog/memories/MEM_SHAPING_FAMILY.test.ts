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
 * `MEM_SHAPING_FAMILY`（家族のかたちを象りながら）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `AFF_KURASUNA`に所属するキャラクターへ与ダメージ+2.5%、コントロールへ攻撃力+1250。
 * 所属とROLEという別軸のフィルタが互いに素な集合を選ぶ。
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

const MEMORY_DEFINITION_ID = "MEM_SHAPING_FAMILY";

/** 所属メンバーは後衛中央の1スロットだけ（コントロールの後衛右とは別スロット）。 */
const BOARD: MemoryBoardOverrides = {
  affiliationsBySlot: { BACK_CENTER: ["AFF_KURASUNA"] },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_SHAPING_FAMILY_AFFILIATION_DMG_UP",
    unitIds: ["ally:BACK_CENTER"],
    magnitude: 0.025,
    damageMod: { direction: "OUTGOING", damageType: null },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SHAPING_FAMILY_CONTROL_ATK_UP",
    unitIds: ["ally:BACK_RIGHT"],
    magnitude: 1250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_SHAPING_FAMILY (家族のかたちを象りながら)", () => {
  it("IT-MEM-SHAPING-FAMILY-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
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
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_KURASUNA" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ROLE", role: "CONTROL" }],
      },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。`grants`はID順、
    // `markers`は別配列なので適用順を表さないが、順序が入れ替わると
    // `EffectApplied`／`MarkerApplied`の発行順が変わり、それを契機にする連鎖が変わる。
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 0, actionIds: ["ACT_MEM_SHAPING_FAMILY_AFFILIATION_DMG_UP"] },
      { triggeredEffectIndex: 1, actionIds: ["ACT_MEM_SHAPING_FAMILY_CONTROL_ATK_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 攻撃力の上昇はコントロールだけ。所属メンバー（後衛中央）には乗らない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:BACK_RIGHT" ? 1250 : 0),
      );
    }
  });

  it("IT-MEM-SHAPING-FAMILY-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の後衛中央も同じ所属を名乗るが、ENEMY宣言では一切影響を受けない。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-SHAPING-FAMILY-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-SHAPING-FAMILY-004 (R-MEM-01): the affiliation triggeredEffect emits no MemoryTriggered at all when no unit on the board belongs to AFF_KURASUNA, while the ROLE-filtered one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants).toEqual([
      {
        effectActionDefinitionId: "ACT_MEM_SHAPING_FAMILY_CONTROL_ATK_UP",
        unitIds: ["ally:BACK_RIGHT"],
        magnitude: 1250,
        statMod: { stat: "ATTACK", valueType: "FIXED" },
        sourceSide: "ALLY",
      },
    ]);
  });
});
