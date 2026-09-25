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
 * `MEM_FIRST_FEELINGS`（はじめてのきもち）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * ユリア・バーンズへ攻撃力+1000、中央列前衛へEN与ダメージ+8.4%。`MEM_KOI` と同型で、
 * `CHARACTER` TargetFilterは`UnitDefinition.metadata.characterId`を引く。原文は
 * 特定バリアントを指定しないため、全ユリア（`UNIT_YURIA_*`）が共有する
 * `CHAR_YURIA_BURNES` で絞る。固定盤面の既定IDは実キャラクターIDと一致しないため、
 * 1スロットだけへ `CHAR_YURIA_BURNES` を名乗らせ、残る5スロットがそのまま非対象の
 * 検証になるようにする。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_FIRST_FEELINGS";

/**
 * ユリアは後衛左に置く。中央列前衛（効果2の対象）と重ならないスロットを選ぶことで、
 * 2つの効果が互いに素な集合へ配られることまで`unitIds`が固定する。
 */
const BOARD: MemoryBoardOverrides = {
  charactersBySlot: { BACK_LEFT: "CHAR_YURIA_BURNES" },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_FIRST_FEELINGS_FRONT_CENTER_EN_DMG_UP",
    unitIds: ["ally:FRONT_CENTER"],
    magnitude: 0.084,
    damageMod: { direction: "OUTGOING", damageType: "EN" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_FIRST_FEELINGS_YURIA_ATK_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 1000,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_FIRST_FEELINGS (はじめてのきもち)", () => {
  it("IT-MEM-FIRST-FEELINGS-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"` が
    // `count: 1` へ退行しても `unitIds` は変わらないため、宣言そのものを固定する。
    expect(observed.targetSelections).toEqual([
      {
        triggeredEffectIndex: 0,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "CHARACTER", characterId: "CHAR_YURIA_BURNES" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [
          { kind: "POSITION_ROW", row: "FRONT" },
          { kind: "POSITION_COLUMN", column: "CENTER" },
        ],
      },
    ]);
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 0, actionIds: ["ACT_MEM_FIRST_FEELINGS_YURIA_ATK_UP"] },
      { triggeredEffectIndex: 1, actionIds: ["ACT_MEM_FIRST_FEELINGS_FRONT_CENTER_EN_DMG_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 攻撃力が動くのはユリアの1体だけ。中央列前衛側は与ダメージ補正なので
    // 能力値は動かない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:BACK_LEFT" ? 1000 : 0),
      );
    }
  });

  it("IT-MEM-FIRST-FEELINGS-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-FIRST-FEELINGS-003: every EffectAction this Memory declares was actually executed", () => {
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD).executedActionIds),
      ),
    ).toEqual([]);
  });

  it("IT-MEM-FIRST-FEELINGS-004 (R-MEM-01): the CHARACTER-filtered triggeredEffect emits no MemoryTriggered when no ally is ユリア・バーンズ, while the position-filtered one still resolves", () => {
    // 対象0件の `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants).toEqual([EXPECTED_GRANTS[0]]);
  });

  it("IT-MEM-FIRST-FEELINGS-005 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
    const observed = observeCoDeclaredMemories(
      { ALLY: [MEMORY_DEFINITION_ID, "MEM_HARD_WARMUP"], ENEMY: ["MEM_STRANGERS"] },
      BOARD,
    );

    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_HARD_WARMUP#0",
      "MEM_HARD_WARMUP#1",
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);

    // ユリア（後衛左）は自Memoryの攻撃力+1000とハードな準備運動……？の後衛+2.5%が重なる。
    expect(observed.statChanges["ally:BACK_LEFT"]).toEqual({ attack: 2025 });
    // 中央列前衛が受けるのは与ダメージ補正で、能力値へは現れない。動くのは
    // ハードな準備運動……？の前衛+4%だけ。
    expect(observed.statChanges["ally:FRONT_CENTER"]).toEqual({ attack: 1040 });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
