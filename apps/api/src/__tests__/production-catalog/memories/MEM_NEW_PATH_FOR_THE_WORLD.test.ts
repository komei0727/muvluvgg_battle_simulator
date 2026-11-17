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
  observeMemoryEffectRemoval,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";
import { runProductionPartyBattle } from "../../../testing/scenario/run-production-battle.js";

/**
 * `MEM_NEW_PATH_FOR_THE_WORLD`（世界は今、新たな道を描いて）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 戦闘開始時、行動速度が最も高い敵単体の行動速度−150、最も低い味方単体の行動速度+150。
 * 固定盤面は全スロットの行動速度が同じなので、両陣営の同じスロットへ最速・最遅を作り、
 * 既定の並び（前列左）と重ならないスロットを選ぶことで、順位キーが効いていることを
 * `unitIds`が固定する。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_NEW_PATH_FOR_THE_WORLD";
const FASTEST_SPEED = MEMORY_COMBAT_STATS.actionSpeed + 50;
const SLOWEST_SPEED = MEMORY_COMBAT_STATS.actionSpeed - 50;

const BOARD: MemoryBoardOverrides = {
  actionSpeedBySlot: { BACK_CENTER: FASTEST_SPEED, FRONT_RIGHT: SLOWEST_SPEED },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_NEW_PATH_FOR_THE_WORLD_FASTEST_ENEMY_SPEED_DOWN",
    unitIds: ["enemy:BACK_CENTER"],
    magnitude: -150,
    statMod: { stat: "ACTION_SPEED", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_NEW_PATH_FOR_THE_WORLD_SLOWEST_ALLY_SPEED_UP",
    unitIds: ["ally:FRONT_RIGHT"],
    magnitude: 150,
    statMod: { stat: "ACTION_SPEED", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

/** 1ターン目の行動順キュー（ユニットごとの最初の予約の順）。 */
function firstTurnActionOrder(allyMemories: readonly string[]): readonly string[] {
  const result = runProductionPartyBattle(
    PRODUCTION_CATALOG_DIR,
    {
      ally: ["UNIT_EVIE_ECO", "UNIT_MIRIAM_MAGE"],
      enemy: ["UNIT_MERU_FLATSPIN"],
      allyMemories,
    },
    { turnLimit: 1 },
  );
  const queue = result.events.find(
    (event) => event.type === "ACTION_QUEUE_CREATED" && event.turnNumber === 1,
  );
  expect(queue, "ACTION_QUEUE_CREATED of turn 1").toBeDefined();
  const reservations = (
    queue!.details as { readonly reservations: readonly { readonly battleUnitId: string }[] }
  ).reservations;
  return [...new Set(reservations.map((reservation) => reservation.battleUnitId))];
}

describe("production Catalog MEM_NEW_PATH_FOR_THE_WORLD (世界は今、新たな道を描いて)", () => {
  it("IT-MEM-NEW-PATH-FOR-THE-WORLD-001: lowers the fastest enemy and raises the slowest ally by 150 action speed when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象は単体で絞り込みなし。順位キー（FASTEST/SLOWEST）は、既定の並びと重ならない
    // スロットが選ばれていること（上の`unitIds`）で固定している。
    expect(observed.targetSelections).toEqual([
      { triggeredEffectIndex: 0, kind: "SELECT", side: "ENEMY", count: 1, filters: [] },
      { triggeredEffectIndex: 1, kind: "SELECT", side: "ALLY", count: 1, filters: [] },
    ]);
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    expect(observed.markers).toEqual([]);
    // 速度が動くのは選ばれた2体だけ。
    const speeds = Object.fromEntries(
      [...observed.started.allyUnits, ...observed.started.enemyUnits].map((unit) => [
        unit.battleUnitId,
        unit.combatStats.actionSpeed,
      ]),
    );
    expect(speeds["enemy:BACK_CENTER"]).toBe(FASTEST_SPEED - 150);
    expect(speeds["ally:FRONT_RIGHT"]).toBe(SLOWEST_SPEED + 150);
    expect(speeds["ally:BACK_CENTER"]).toBe(FASTEST_SPEED);
    expect(speeds["enemy:FRONT_RIGHT"]).toBe(SLOWEST_SPEED);
    expect(speeds["ally:FRONT_LEFT"]).toBe(MEMORY_COMBAT_STATS.actionSpeed);
  });

  it("IT-MEM-NEW-PATH-FOR-THE-WORLD-002 (R-MEM-04): the same Memory declared by the ENEMY side picks the fastest of its opponents and the slowest of its own side", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-NEW-PATH-FOR-THE-WORLD-003: every EffectAction this Memory declares was actually executed", () => {
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD).executedActionIds),
      ),
    ).toEqual([]);
  });

  it("IT-MEM-NEW-PATH-FOR-THE-WORLD-004 (R-TGT-02): when every unit has the same action speed, the single target falls back to the default order (front row, left first)", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants.map((grant) => grant.unitIds)).toEqual([
      ["enemy:FRONT_LEFT"],
      ["ally:FRONT_LEFT"],
    ]);
  });

  it("IT-MEM-NEW-PATH-FOR-THE-WORLD-005: no memory-granted effect is removed by an unlimited BUFF/DEBUFF REMOVE_EFFECTS because every one is declared undispellable", () => {
    // メモリー由来の付与は解除不可（Issue #693）。
    const observed = observeMemoryEffectRemoval(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.heldBefore).toEqual([
      "ACT_MEM_NEW_PATH_FOR_THE_WORLD_FASTEST_ENEMY_SPEED_DOWN",
      "ACT_MEM_NEW_PATH_FOR_THE_WORLD_SLOWEST_ALLY_SPEED_UP",
    ]);
    expect(observed.removed).toEqual([]);
    expect(observed.heldAfter).toEqual(observed.heldBefore);
  });

  /**
   * 開始時の行動速度は MERU_FLATSPIN（敵）> MIRIAM_MAGE > EVIE_ECO で、差はいずれも150未満。
   * Memoryは行動順キュー生成前に解決されるため（R-MEM-03）、1ターン目から
   * 最遅の味方（EVIE_ECO）が先頭へ、最速の敵（MERU_FLATSPIN）が末尾へ回る。
   */
  it("IT-MEM-NEW-PATH-FOR-THE-WORLD-006 (R-MEM-03): the speed changes reorder the first turn's action queue", () => {
    // 編成は前列左から ally:1（EVIE_ECO）、ally:2（MIRIAM_MAGE）。敵は enemy:1（MERU_FLATSPIN）。
    expect(firstTurnActionOrder([])).toEqual(["enemy:1", "ally:2", "ally:1"]);
    expect(firstTurnActionOrder([MEMORY_DEFINITION_ID])).toEqual(["ally:1", "ally:2", "enemy:1"]);
  });
});
