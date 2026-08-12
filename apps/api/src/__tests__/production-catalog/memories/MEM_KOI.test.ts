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
 * `MEM_KOI`（『こい』）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * リディア・エルドリッジへ攻撃力+1000、中央列後衛へ物理与ダメージ+10.5%。
 * `CHARACTER` TargetFilter（特定キャラクター限定）を使う定義であり、絞り込みは
 * `UnitDefinition.metadata.characterId` を引く。固定盤面の既定IDは実キャラクター
 * IDと一致しないため、1スロットだけへ `CHAR_LYDIA_ELDRIDGE` を名乗らせ、残る
 * 5スロットがそのまま非対象の検証になるようにする。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_KOI";

/**
 * リディアは後衛左に置く。中央列後衛（効果2の対象）と重ならないスロットを選ぶことで、
 * 2つの効果が互いに素な集合へ配られることまで`unitIds`が固定する。
 */
const BOARD: MemoryBoardOverrides = {
  charactersBySlot: { BACK_LEFT: "CHAR_LYDIA_ELDRIDGE" },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_KOI_BACK_CENTER_PHYSICAL_DMG_UP",
    unitIds: ["ally:BACK_CENTER"],
    magnitude: 0.105,
    damageMod: { direction: "OUTGOING", damageType: "PHYSICAL" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_KOI_LYDIA_ATK_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 1000,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_KOI (『こい』)", () => {
  it("IT-MEM-KOI-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
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
        filters: [{ kind: "CHARACTER", characterId: "CHAR_LYDIA_ELDRIDGE" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [
          { kind: "POSITION_ROW", row: "BACK" },
          { kind: "POSITION_COLUMN", column: "CENTER" },
        ],
      },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。`grants`はID順、
    // `markers`は別配列なので適用順を表さないが、順序が入れ替わると
    // `EffectApplied`／`MarkerApplied`の発行順が変わり、それを契機にする連鎖が変わる。
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 0, actionIds: ["ACT_MEM_KOI_LYDIA_ATK_UP"] },
      { triggeredEffectIndex: 1, actionIds: ["ACT_MEM_KOI_BACK_CENTER_PHYSICAL_DMG_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 攻撃力が動くのはリディアの1体だけ。中央列後衛側は与ダメージ補正なので
    // 能力値は動かない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:BACK_LEFT" ? 1000 : 0),
      );
    }
  });

  it("IT-MEM-KOI-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の同じスロットも同じキャラクターIDを名乗るが、ENEMY宣言では
    // 一切影響を受けない。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-KOI-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-KOI-004 (R-MEM-01): the CHARACTER-filtered triggeredEffect emits no MemoryTriggered when no ally is リディア・エルドリッジ, while the position-filtered one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。既定盤面の
    // `characterId` は `CHAR_UNIT_TEST_MEMORY_<slot>` で、実キャラクターIDと
    // 一致しないため効果1だけが落ちる。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants).toEqual([EXPECTED_GRANTS[0]]);
  });

  it("IT-MEM-KOI-005 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
    // 跨Memoryの解決順・同一スロットへの重ね掛け・複数Memory分をまとめたStateDelta
    // 復元は、複数Memoryを**同時に**編成したときにしか現れない。
    const observed = observeCoDeclaredMemories(
      { ALLY: [MEMORY_DEFINITION_ID, "MEM_HARD_WARMUP"], ENEMY: ["MEM_STRANGERS"] },
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
        { ALLY: ["MEM_HARD_WARMUP", MEMORY_DEFINITION_ID], ENEMY: ["MEM_STRANGERS"] },
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

    // リディア（後衛左）は自Memoryの攻撃力+1000とハードな準備運動……？の後衛+2.5%が重なる。
    expect(observed.statChanges["ally:BACK_LEFT"]).toEqual({ attack: 2025 });
    // 中央列後衛が受けるのは与ダメージ補正で、能力値へは現れない。動くのは
    // ハードな準備運動……？の後衛+2.5%だけ。
    expect(observed.statChanges["ally:BACK_CENTER"]).toEqual({ attack: 1025 });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
