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
 * `MEM_EURO_TOWER_DAY`（１日ユーロ・タワー体験）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * SUPPORTロールへ攻撃力+4%（割合）、後衛の中央・右へ攻撃力+1250（固定値）。ロール絞りと位置絞りが別々の集合を選ぶ。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_EURO_TOWER_DAY";

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_EURO_TOWER_DAY_BACK_CENTER_RIGHT_ATK_UP",
    unitIds: ["ally:BACK_CENTER", "ally:BACK_RIGHT"],
    magnitude: 1250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_EURO_TOWER_DAY_SUPPORT_ATK_UP",
    unitIds: ["ally:FRONT_RIGHT", "ally:BACK_CENTER"],
    magnitude: 0.04,
    statMod: { stat: "ATTACK", valueType: "RATIO" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_EURO_TOWER_DAY (１日ユーロ・タワー体験)", () => {
  it("IT-MEM-EURO-TOWER-DAY-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
  });

  it("IT-MEM-EURO-TOWER-DAY-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY")).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-EURO-TOWER-DAY-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-EURO-TOWER-DAY-004 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
    // 跨Memoryの解決順・同一スロットへの重ね掛け・複数Memory分をまとめたStateDelta
    // 復元は、複数Memoryを**同時に**編成したときにしか現れない。
    const observed = observeCoDeclaredMemories({
      ALLY: [MEMORY_DEFINITION_ID, "MEM_HARD_WARMUP"],
      ENEMY: ["MEM_STRANGERS"],
    });

    // R-MEM-02: API指定順 → 同一Memory内の`triggeredEffects`定義順。ALLY候補を
    // すべて解決してからENEMY候補へ進む。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
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
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);

    // 自MemoryのSUPPORT+4%と中央後衛+1250に、ハードな準備運動……？の後衛+2.5%が乗る。RATIOは加算で合成される（1000×1.065＋1250）。
    expect(observed.statChanges["ally:BACK_CENTER"]).toEqual({ attack: 2315 });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
