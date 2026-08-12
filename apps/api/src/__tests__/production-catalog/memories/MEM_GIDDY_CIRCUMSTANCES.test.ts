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
 * `MEM_GIDDY_CIRCUMSTANCES`（浮かれた事情）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * アグレッシブ属性へ攻撃力+1500、スマート属性へ攻撃力+1500。**2件とも
 * ターン開始時発動**であり、全36Memoryのうち`BattleStarted`発動の
 * `triggeredEffect`を1件も持たない唯一の定義である。したがって`-001` は
 * 「戦闘開始時には何も配られない」ことを固定し、効果の発現は`-002`以降の
 * ターン開始観測が持つ。
 *
 * `ATTRIBUTE`は`UnitDefinition`ではなく編成時に決まる`BattleUnit.attribute`を読む。
 * 既定は`AGGRESSIVE`なので、既定のままだと効果1が6スロット全てへ当たり
 * 「属性で絞っている」ことを検証できない。2スロットへ別属性を持たせ、
 * アグレッシブ4体・スマート1体・どちらでもない1体へ割り付ける。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_GIDDY_CIRCUMSTANCES";

/** 前衛中央をスマート、後衛右をキュート（どちらの効果の対象でもない）にする。 */
const BOARD: MemoryBoardOverrides = {
  attributesBySlot: { FRONT_CENTER: "SMART", BACK_RIGHT: "CUTE" },
};

const AGGRESSIVE_ALLY_SLOTS = [
  "ally:FRONT_LEFT",
  "ally:FRONT_RIGHT",
  "ally:BACK_LEFT",
  "ally:BACK_CENTER",
];

/** ターン開始ごとに発現する効果（EffectAction ID順）。 */
const EXPECTED_TURN_START_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_GIDDY_CIRCUMSTANCES_AGGRESSIVE_ATK_UP",
    unitIds: AGGRESSIVE_ALLY_SLOTS,
    magnitude: 1500,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_GIDDY_CIRCUMSTANCES_SMART_ATK_UP",
    unitIds: ["ally:FRONT_CENTER"],
    magnitude: 1500,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_GIDDY_CIRCUMSTANCES (浮かれた事情)", () => {
  it("IT-MEM-GIDDY-CIRCUMSTANCES-001: nothing manifests at startBattle because both triggeredEffects are TurnStarted-triggered", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual([]);
    expect(observed.markers).toEqual([]);
    expect(observed.actionOrder).toEqual([]);
    // R-MEM-02: `BattleStarted` では両`triggeredEffect`とも候補にならない。
    expect(observed.triggeredOrder).toEqual([]);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"`（対象と
    // なる陣営全員）が `count: 1` へ退行しても、絞り込みを同じ1体を引く別の
    // `filters` へ差し替えても `unitIds` は変わらない。宣言そのものを固定する。
    expect(observed.targetSelections).toEqual([
      {
        triggeredEffectIndex: 0,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ATTRIBUTE", attribute: "AGGRESSIVE" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "ATTRIBUTE", attribute: "SMART" }],
      },
    ]);
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack);
    }
  });

  it("IT-MEM-GIDDY-CIRCUMSTANCES-002: both EffectActions manifest on exactly the declared slots with the declared magnitude at the first turn start", () => {
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD).turnStarts;
    expect(firstTurn?.grants).toEqual(EXPECTED_TURN_START_GRANTS);
    // R-MEM-02: 同一Memory内の`triggeredEffects`は定義順に、1件も飛ばさず解決される。
    expect(firstTurn?.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
  });

  it("IT-MEM-GIDDY-CIRCUMSTANCES-003 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の同じスロットも同じ属性を持つが、ENEMY宣言では一切影響を受けない。
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ENEMY", 1, BOARD).turnStarts;
    expect(firstTurn?.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_TURN_START_GRANTS));
  });

  it("IT-MEM-GIDDY-CIRCUMSTANCES-004: every EffectAction this Memory declares was actually executed", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。
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

  it("IT-MEM-GIDDY-CIRCUMSTANCES-005 (R-MEM-01): both triggeredEffects re-grant on every turn and accumulate, and neither fires for an ally carrying neither attribute", () => {
    const { turnStarts, battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2, BOARD);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    for (const turn of turnStarts) {
      expect(turn.grants).toEqual(EXPECTED_TURN_START_GRANTS);
    }
    // 原文に期間の指定がないため、ターンごとの付与は失効せず積み上がる。
    // キュート属性の後衛右はどちらの効果の対象でもないため基礎値のまま。
    for (const unit of battle.allyUnits) {
      const isTarget = unit.battleUnitId !== "ally:BACK_RIGHT";
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack + (isTarget ? 3000 : 0));
    }
    // Memoryを宣言していない敵陣営は2ターン進めても一切影響を受けない。
    for (const unit of battle.enemyUnits) {
      expect(unit.appliedEffects).toHaveLength(0);
    }
  });
});
