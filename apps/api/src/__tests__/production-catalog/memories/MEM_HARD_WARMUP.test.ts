import { describe, expect, it } from "vitest";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  type MemoryGrant,
  mirroredForEnemyDeclaration,
  observeCoDeclaredMemories,
  observeMemory,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_HARD_WARMUP`（ハードな準備運動……？）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 前衛へ攻撃力+4%、後衛へ+2.5%。行を分ける2件の`APPLY_STAT_MOD`だけで構成され、両者の対象集合は重ならない。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_HARD_WARMUP";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_HARD_WARMUP_BACK_ATK_UP",
    unitIds: ["ally:BACK_LEFT", "ally:BACK_CENTER", "ally:BACK_RIGHT"],
    magnitude: 0.025,
    statMod: { stat: "ATTACK", valueType: "RATIO" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_HARD_WARMUP_FRONT_ATK_UP",
    unitIds: ["ally:FRONT_LEFT", "ally:FRONT_CENTER", "ally:FRONT_RIGHT"],
    magnitude: 0.04,
    statMod: { stat: "ATTACK", valueType: "RATIO" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_HARD_WARMUP (ハードな準備運動……？)", () => {
  it("IT-MEM-HARD-WARMUP-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"`（対象と
    // なる陣営全員）が `count: 1` へ退行しても `unitIds` は変わらないため、宣言
    // そのものを固定する。
    expect(observed.targetSelections).toEqual([
      { triggeredEffectIndex: 0, kind: "SELECT", side: "ALLY", count: "ALL" },
      { triggeredEffectIndex: 1, kind: "SELECT", side: "ALLY", count: "ALL" },
    ]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
  });

  it("IT-MEM-HARD-WARMUP-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-HARD-WARMUP-003: every EffectAction this Memory declares was actually executed", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY").executedActionIds),
      ),
    ).toEqual([]);
  });

  it("IT-MEM-HARD-WARMUP-004 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
    // 跨Memoryの解決順・同一スロットへの重ね掛け・複数Memory分をまとめたStateDelta
    // 復元は、複数Memoryを**同時に**編成したときにしか現れない。
    const observed = observeCoDeclaredMemories({
      ALLY: [MEMORY_DEFINITION_ID, "MEM_HEART_COLOR"],
      ENEMY: ["MEM_STRANGERS"],
    });

    // R-MEM-02: API指定順 → 同一Memory内の`triggeredEffects`定義順。ALLY候補を
    // すべて解決してからENEMY候補へ進む。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_HEART_COLOR#0",
      "MEM_HEART_COLOR#1",
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);
    // 宣言順を入れ替えると解決順も入れ替わる（ID順でも定義順でもなくAPI指定順である）。
    expect(
      observeCoDeclaredMemories({
        ALLY: ["MEM_HEART_COLOR", MEMORY_DEFINITION_ID],
        ENEMY: ["MEM_STRANGERS"],
      }).triggeredOrder,
    ).toEqual([
      "MEM_HEART_COLOR#0",
      "MEM_HEART_COLOR#1",
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);

    // 自Memoryの前衛+4%（1000→1040）と、色は心のままにの会心ダメージ+10%（0.5→0.55）が重なる。
    expect(observed.statChanges["ally:FRONT_LEFT"]).toEqual({
      attack: 1040,
      criticalDamageBonus: 0.55,
    });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
