import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  MEMORY_COMBAT_STATS,
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeCoDeclaredMemories,
  observeMemory,
  observeMemoryGrants,
  observeMemoryTurnStarts,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_DISCONTENT_AND_ANXIETY`（不満と不安）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1は**ターン開始時**に発動して前衛へ攻撃力+1%（割合）、効果2は戦闘開始時に
 * 発動して後衛へHP+1500。発動契機の違う2件が1つのMemoryに同居するため、
 * `-001` は戦闘開始時に効果1が出ないことを、`-004` は毎ターン効果1だけが
 * 重ねて配られることを固定する。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_DISCONTENT_AND_ANXIETY";

const BACK_ALLY_SLOTS = ["ally:BACK_LEFT", "ally:BACK_CENTER", "ally:BACK_RIGHT"];
const FRONT_ALLY_SLOTS = ["ally:FRONT_LEFT", "ally:FRONT_CENTER", "ally:FRONT_RIGHT"];

/**
 * 戦闘開始時に発現する効果（EffectAction ID順）。`TurnStarted` 発動の効果1は
 * ここに現れない。盤面は`MEMORY_SLOTS`の6スロット×両陣営。
 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_DISCONTENT_AND_ANXIETY_BACK_HP_UP",
    unitIds: BACK_ALLY_SLOTS,
    magnitude: 1500,
    statMod: { stat: "MAXIMUM_HP", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

/** ターン開始ごとに発現する効果。 */
const EXPECTED_TURN_START_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_DISCONTENT_AND_ANXIETY_FRONT_ATK_UP",
    unitIds: FRONT_ALLY_SLOTS,
    magnitude: 0.01,
    statMod: { stat: "ATTACK", valueType: "RATIO" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_DISCONTENT_AND_ANXIETY (不満と不安)", () => {
  it("IT-MEM-DISCONTENT-AND-ANXIETY-001: only the BattleStarted triggeredEffect manifests at startBattle, on exactly the declared slots with the declared magnitude", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
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
        filters: [{ kind: "POSITION_ROW", row: "FRONT" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "POSITION_ROW", row: "BACK" }],
      },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。`grants`はID順、
    // `markers`は別配列なので適用順を表さないが、順序が入れ替わると
    // `EffectApplied`／`MarkerApplied`の発行順が変わり、それを契機にする連鎖が変わる。
    // 効果1は`TurnStarted`発動なので、`BattleStarted`では`MemoryTriggered`ごと現れない。
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 1, actionIds: ["ACT_MEM_DISCONTENT_AND_ANXIETY_BACK_HP_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に解決されるが、`TurnStarted` 発動の
    // 効果1（index 0）は`BattleStarted`では候補にならず、飛ばされる。
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
  });

  it("IT-MEM-DISCONTENT-AND-ANXIETY-002 (R-MEM-04): the same Memory declared by the ENEMY side lands both triggers on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
    // `TurnStarted` 発動の効果1は`startBattle`だけの観測に現れないため、
    // ターンを進めた側でも鏡像を取る（片方だけだと対象陣営や`sourceSide`の
    // 取り違えがALLY宣言でしか観測されない効果で見逃される）。
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ENEMY", 1).turnStarts;
    expect(firstTurn?.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_TURN_START_GRANTS));
  });

  it("IT-MEM-DISCONTENT-AND-ANXIETY-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-DISCONTENT-AND-ANXIETY-004 (R-MEM-01): the TurnStarted triggeredEffect re-grants the front-row ATTACK buff on every turn while the BattleStarted one never repeats", () => {
    const { turnStarts } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    for (const turn of turnStarts) {
      // 効果2（`BattleStarted`）は`TurnStarted`の解決スコープには一切現れない。
      expect(turn.grants).toEqual(EXPECTED_TURN_START_GRANTS);
      expect(turn.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#0`]);
    }
  });

  it("IT-MEM-DISCONTENT-AND-ANXIETY-005: the per-turn ATTACK buff accumulates over turns while the once-only back-row MAXIMUM_HP buff stays at one instance", () => {
    // 原文に期間の指定がないため、ターンごとの付与は失効せず積み上がる。
    const { battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2);
    for (const unit of battle.allyUnits) {
      const isFront = FRONT_ALLY_SLOTS.includes(unit.battleUnitId);
      // 前衛は2ターン分の効果1が2件、後衛は戦闘開始時の効果2が1件だけ。
      expect(unit.appliedEffects.map((effect) => effect.effectActionDefinitionId)).toEqual(
        isFront
          ? [
              "ACT_MEM_DISCONTENT_AND_ANXIETY_FRONT_ATK_UP",
              "ACT_MEM_DISCONTENT_AND_ANXIETY_FRONT_ATK_UP",
            ]
          : ["ACT_MEM_DISCONTENT_AND_ANXIETY_BACK_HP_UP"],
      );
      expect(unit.combatStats.attack).toBeCloseTo(
        isFront ? MEMORY_COMBAT_STATS.attack * 1.02 : MEMORY_COMBAT_STATS.attack,
        6,
      );
      expect(unit.combatStats.maximumHp).toBe(MEMORY_COMBAT_STATS.maximumHp + (isFront ? 0 : 1500));
    }
    // Memoryを宣言していない敵陣営は2ターン進めても一切影響を受けない。
    for (const unit of battle.enemyUnits) {
      expect(unit.appliedEffects).toHaveLength(0);
    }
  });

  it("IT-MEM-DISCONTENT-AND-ANXIETY-006 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
    // 跨Memoryの解決順・同一スロットへの重ね掛け・複数Memory分をまとめたStateDelta
    // 復元は、複数Memoryを**同時に**編成したときにしか現れない。
    const observed = observeCoDeclaredMemories({
      ALLY: [MEMORY_DEFINITION_ID, "MEM_HARD_WARMUP"],
      ENEMY: ["MEM_STRANGERS"],
    });

    // R-MEM-02: API指定順 → 同一Memory内の`triggeredEffects`定義順。ALLY候補を
    // すべて解決してからENEMY候補へ進む。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_HARD_WARMUP#0",
      "MEM_HARD_WARMUP#1",
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);
    // 宣言順を入れ替えると解決順も入れ替わる（ID順でも定義順でもなくAPI指定順である）。
    expect(
      observeCoDeclaredMemories({
        ALLY: ["MEM_HARD_WARMUP", MEMORY_DEFINITION_ID],
        ENEMY: ["MEM_STRANGERS"],
      }).triggeredOrder,
    ).toEqual([
      "MEM_HARD_WARMUP#0",
      "MEM_HARD_WARMUP#1",
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);

    // `BattleStarted`発動の後衛HP+1500だけが乗る（`TurnStarted`発動の効果1は戦闘開始では配られない）。攻撃力はハードな準備運動……？の後衛+2.5%。
    expect(observed.statChanges["ally:BACK_LEFT"]).toEqual({ maximumHp: 11500, attack: 1025 });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
