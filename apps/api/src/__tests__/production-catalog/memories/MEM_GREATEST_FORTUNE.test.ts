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
  observeMemoryTurnStarts,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_GREATEST_FORTUNE`（最大の幸運は）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * シャイ属性へ攻撃力+1500、キュート属性へ攻撃力+1500。**2件ともターン開始時発動**
 * であり、`MEM_GIDDY_CIRCUMSTANCES` と同じく `BattleStarted` 発動の
 * `triggeredEffect` を1件も持たない。したがって`-001` は「戦闘開始時には何も
 * 配られない」ことを固定し、効果の発現は`-002`以降のターン開始観測が持つ。
 *
 * `ATTRIBUTE`は`UnitDefinition`ではなく編成時に決まる`BattleUnit.attribute`を読む。
 * 既定は`AGGRESSIVE`（どちらの効果の対象でもない）なので、3スロットだけへ対象属性を
 * 持たせ、残る3スロットがそのまま非対象の検証になるようにする。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_GREATEST_FORTUNE";

/** 前衛左右をシャイ、後衛中央をキュートにする。残る3スロットは既定のアグレッシブ。 */
const BOARD: MemoryBoardOverrides = {
  attributesBySlot: { FRONT_LEFT: "SHY", FRONT_RIGHT: "SHY", BACK_CENTER: "CUTE" },
};

const SHY_ALLY_SLOTS = ["ally:FRONT_LEFT", "ally:FRONT_RIGHT"];
const TARGET_ALLY_SLOTS = new Set([...SHY_ALLY_SLOTS, "ally:BACK_CENTER"]);

/** ターン開始ごとに発現する効果（EffectAction ID順のため、定義順と逆にキュートが先）。 */
const EXPECTED_TURN_START_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_GREATEST_FORTUNE_CUTE_ATK_UP",
    unitIds: ["ally:BACK_CENTER"],
    magnitude: 1500,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_GREATEST_FORTUNE_SHY_ATK_UP",
    unitIds: SHY_ALLY_SLOTS,
    magnitude: 1500,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_GREATEST_FORTUNE (最大の幸運は)", () => {
  it("IT-MEM-GREATEST-FORTUNE-001: nothing manifests at startBattle because both triggeredEffects are TurnStarted-triggered", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual([]);
    expect(observed.markers).toEqual([]);
    expect(observed.actionOrder).toEqual([]);
    // R-MEM-02: `BattleStarted` では両`triggeredEffect`とも候補にならない。
    expect(observed.triggeredOrder).toEqual([]);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"` が
    // `count: 1` へ退行しても `unitIds` は変わらないため、宣言そのものを固定する。
    expect(observed.targetSelections).toEqual([
      {
        triggeredEffectIndex: 0,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ATTRIBUTE", attribute: "SHY" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ATTRIBUTE", attribute: "CUTE" }],
      },
    ]);
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack);
    }
  });

  it("IT-MEM-GREATEST-FORTUNE-002: both EffectActions manifest on exactly the declared slots with the declared magnitude at the first turn start", () => {
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD).turnStarts;
    expect(firstTurn?.grants).toEqual(EXPECTED_TURN_START_GRANTS);
    // R-MEM-02: 同一Memory内の`triggeredEffects`は定義順に、1件も飛ばさず解決される。
    expect(firstTurn?.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
  });

  it("IT-MEM-GREATEST-FORTUNE-003 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ENEMY", 1, BOARD).turnStarts;
    expect(firstTurn?.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_TURN_START_GRANTS));
  });

  it("IT-MEM-GREATEST-FORTUNE-004: every EffectAction this Memory declares was actually executed", () => {
    // 2件とも`TurnStarted`発動なので、閉包はターンを進めた観測だけが埋める。
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    const executed = new Set(
      observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD).turnStarts.flatMap(
        (turn) => turn.executedActionIds,
      ),
    );
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        executed,
      ),
    ).toEqual([]);
  });

  it("IT-MEM-GREATEST-FORTUNE-005 (R-MEM-01): both triggeredEffects re-grant on every turn and accumulate, and neither fires for an ally carrying neither attribute", () => {
    const { turnStarts, battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2, BOARD);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    for (const turn of turnStarts) {
      expect(turn.grants).toEqual(EXPECTED_TURN_START_GRANTS);
    }
    // 原文に期間の指定がないため、ターンごとの付与は失効せず積み上がる。
    // アグレッシブ属性の3スロットはどちらの効果の対象でもないため基礎値のまま。
    for (const unit of battle.allyUnits) {
      const isTarget = TARGET_ALLY_SLOTS.has(unit.battleUnitId);
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack + (isTarget ? 3000 : 0));
    }
    for (const unit of battle.enemyUnits) {
      expect(unit.appliedEffects).toHaveLength(0);
    }
  });

  it("IT-MEM-GREATEST-FORTUNE-006 (R-ATR-04): an ally whose subAttribute is SHY is also targeted by the shy-only effect, even though its main attribute is AGGRESSIVE", () => {
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, {
      ...BOARD,
      subAttributesBySlot: { BACK_RIGHT: "SHY" },
    }).turnStarts;
    expect(firstTurn?.grants).toEqual([
      EXPECTED_TURN_START_GRANTS[0],
      {
        effectActionDefinitionId: "ACT_MEM_GREATEST_FORTUNE_SHY_ATK_UP",
        unitIds: [...SHY_ALLY_SLOTS, "ally:BACK_RIGHT"],
        magnitude: 1500,
        statMod: { stat: "ATTACK", valueType: "FIXED" },
        sourceSide: "ALLY",
      },
    ]);
  });
});
