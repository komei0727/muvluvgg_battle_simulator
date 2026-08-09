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
  observeMemoryTurnStarts,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_BUSY_DAY_SLUMBER`（忙しい時のまどろみ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1は**ターン開始時**に発動して後衛へ「次に受ける被ダメージ-5%」を付与し、
 * 効果2は戦闘開始時に発動して後衛へ防御力+1000。同じ後衛集合を選びながら
 * 発動契機が違い、効果1だけが期間ではなく**消費**（`NEXT_INCOMING_ATTACK`）で失効する。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_BUSY_DAY_SLUMBER";

const BACK_ALLY_SLOTS = ["ally:BACK_LEFT", "ally:BACK_CENTER", "ally:BACK_RIGHT"];

/**
 * 戦闘開始時に発現する効果（EffectAction ID順）。`TurnStarted` 発動の効果1は
 * ここに現れない。盤面は`MEMORY_SLOTS`の6スロット×両陣営。
 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_BUSY_DAY_SLUMBER_BACK_DEF_UP",
    unitIds: BACK_ALLY_SLOTS,
    magnitude: 1000,
    sourceSide: "ALLY",
  },
];

/** ターン開始ごとに発現する効果。 */
const EXPECTED_TURN_START_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_BUSY_DAY_SLUMBER_BACK_DMG_DOWN",
    unitIds: BACK_ALLY_SLOTS,
    magnitude: -0.05,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_BUSY_DAY_SLUMBER (忙しい時のまどろみ)", () => {
  it("IT-MEM-BUSY-DAY-SLUMBER-001: only the BattleStarted triggeredEffect manifests at startBattle, on exactly the declared slots with the declared magnitude", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に解決されるが、`TurnStarted` 発動の
    // 効果1（index 0）は`BattleStarted`では候補にならず、飛ばされる。
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.defense).toBe(
        MEMORY_COMBAT_STATS.defense + (BACK_ALLY_SLOTS.includes(unit.battleUnitId) ? 1000 : 0),
      );
    }
  });

  it("IT-MEM-BUSY-DAY-SLUMBER-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-BUSY-DAY-SLUMBER-003: every EffectAction this Memory declares was actually executed", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。
    // `TurnStarted` 発動の効果は`startBattle`だけでは実行されないため、
    // ターンを進めた観測と合わせて閉包を埋める。
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    const executed = new Set([
      ...observeMemory(MEMORY_DEFINITION_ID, "ALLY").executedActionIds,
      ...observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1).turnStarts.flatMap(
        (turn) => turn.executedActionIds,
      ),
    ]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        executed,
      ),
    ).toEqual([]);
  });

  it("IT-MEM-BUSY-DAY-SLUMBER-004 (R-MEM-01): the TurnStarted triggeredEffect re-grants the back-row incoming-damage reduction on every turn while the BattleStarted one never repeats", () => {
    const { turnStarts } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    for (const turn of turnStarts) {
      // 効果2（`BattleStarted`）は`TurnStarted`の解決スコープには一切現れない。
      expect(turn.grants).toEqual(EXPECTED_TURN_START_GRANTS);
      expect(turn.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#0`]);
    }
  });

  it("IT-MEM-BUSY-DAY-SLUMBER-005 (R-EFF-05): the granted per-turn buff carries the next-incoming-attack consumption instead of a time limit, unlike the battle-long DEFENSE buff", () => {
    // 「次に受ける被ダメージを5％減少」— 原文は期間ではなく消費点を宣言している。
    // 期間で表すと、被弾していないターンをまたいで残り続けてしまう。
    const { battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1);
    const backLeft = battle.allyUnits.find((unit) => unit.battleUnitId === "ally:BACK_LEFT");
    const reduction = backLeft?.appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === "ACT_MEM_BUSY_DAY_SLUMBER_BACK_DMG_DOWN",
    );
    expect(reduction?.duration.definition).toMatchObject({
      consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
    });
    expect(reduction?.duration.definition.timeLimit).toBeUndefined();
    // 戦闘開始時の防御力バフのほうは戦闘終了まで残る期間を持つ。
    const defenseBuff = backLeft?.appliedEffects.find(
      (effect) => effect.effectActionDefinitionId === "ACT_MEM_BUSY_DAY_SLUMBER_BACK_DEF_UP",
    );
    expect(defenseBuff?.duration.definition.timeLimit).toEqual({ unit: "BATTLE", count: 1 });
  });
});
