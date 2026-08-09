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
  observeCoDeclaredMemories,
  observeMemory,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_INCOGNITO_SISTER_ADVENTURE`（お忍びシスターの冒険）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * `AFF_PYXIS_MA_SOEUR`に所属するキャラクターへ防御力+800（固定値）、
 * PHYSICAL_ATTACKERロールへ攻撃力+2.5%（割合）。所属で絞る集合とロールで絞る集合が
 * **互いに素**になるようにスロットを割り付け、片方の絞り込みがもう片方を巻き込まない
 * ことを表で固定する。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_INCOGNITO_SISTER_ADVENTURE";

/** 所属メンバーは後衛右（CONTROLロール）— PHYSICAL_ATTACKERの前衛左とは重ならない。 */
const BOARD: MemoryBoardOverrides = {
  affiliationsBySlot: { BACK_RIGHT: ["AFF_PYXIS_MA_SOEUR"] },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_INCOGNITO_SISTER_ADVENTURE_AFFILIATION_DEF_UP",
    unitIds: ["ally:BACK_RIGHT"],
    magnitude: 800,
    statMod: { stat: "DEFENSE", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_INCOGNITO_SISTER_ADVENTURE_PHYSICAL_ATTACKER_ATK_UP",
    unitIds: ["ally:FRONT_LEFT"],
    magnitude: 0.025,
    statMod: { stat: "ATTACK", valueType: "RATIO" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_INCOGNITO_SISTER_ADVENTURE (お忍びシスターの冒険)", () => {
  it("IT-MEM-INCOGNITO-SISTER-ADVENTURE-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
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
    // 固定値と割合が、互いに素な集合へ別々に乗る。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.defense).toBe(
        MEMORY_COMBAT_STATS.defense + (unit.battleUnitId === "ally:BACK_RIGHT" ? 800 : 0),
      );
      expect(unit.combatStats.attack).toBeCloseTo(
        unit.battleUnitId === "ally:FRONT_LEFT"
          ? MEMORY_COMBAT_STATS.attack * 1.025
          : MEMORY_COMBAT_STATS.attack,
        6,
      );
    }
  });

  it("IT-MEM-INCOGNITO-SISTER-ADVENTURE-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の後衛右も`AFF_PYXIS_MA_SOEUR`を名乗るが、ENEMY宣言では
    // 一切影響を受けない（所属は陣営を越えない）。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-INCOGNITO-SISTER-ADVENTURE-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-INCOGNITO-SISTER-ADVENTURE-004 (R-MEM-01): the affiliation triggeredEffect emits no MemoryTriggered at all when no unit on the board belongs to AFF_PYXIS_MA_SOEUR, while the ROLE-filtered one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants.map((grant) => grant.effectActionDefinitionId)).toEqual([
      "ACT_MEM_INCOGNITO_SISTER_ADVENTURE_PHYSICAL_ATTACKER_ATK_UP",
    ]);
  });

  it("IT-MEM-INCOGNITO-SISTER-ADVENTURE-005 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
    // 跨Memoryの解決順・同一スロットへの重ね掛け・複数Memory分をまとめたStateDelta
    // 復元は、複数Memoryを**同時に**編成したときにしか現れない。
    const observed = observeCoDeclaredMemories(
      {
        ALLY: [MEMORY_DEFINITION_ID, "MEM_HARD_WARMUP"],
        ENEMY: ["MEM_STRANGERS"],
      },
      BOARD,
    );

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
      observeCoDeclaredMemories(
        {
          ALLY: ["MEM_HARD_WARMUP", MEMORY_DEFINITION_ID],
          ENEMY: ["MEM_STRANGERS"],
        },
        BOARD,
      ).triggeredOrder,
    ).toEqual([
      "MEM_HARD_WARMUP#0",
      "MEM_HARD_WARMUP#1",
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);

    // 自Memoryの所属メンバー防御力+800に、ハードな準備運動……？の後衛+2.5%が乗る。
    expect(observed.statChanges["ally:BACK_RIGHT"]).toEqual({ attack: 1025, defense: 1300 });
    // 物理アタッカーへの+2.5%とハードな準備運動……？の前衛+4%は同じATTACKへ加算で合成される（1000×1.065）。
    expect(observed.statChanges["ally:FRONT_LEFT"]).toEqual({ attack: 1065 });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
