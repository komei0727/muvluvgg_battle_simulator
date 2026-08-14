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
 * `MEM_FANTASY_SCULPTOR_ROSIE`（空想造形師ロージー）のユニット単位production結合
 * テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * ロージー・ヒューズへ会心率+3%、右列前衛へ会心ダメージ+10.5%。どちらも
 * `valueType: RATIO`（基礎値に対する割合）で、`15_Unit_Memory変換台帳.md`が
 * 記録する既存の会心率変換の慣習に揃えてある。
 *
 * `CHARACTER` TargetFilterは`UnitDefinition.metadata.characterId`を引く。固定盤面の
 * 既定IDは実キャラクターIDと一致しないため、1スロットだけへ`CHAR_ROSIE_HUGHES`を
 * 名乗らせ、残る5スロットがそのまま非対象の検証になるようにする。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_FANTASY_SCULPTOR_ROSIE";

/** ロージーは後衛左に置く。右列前衛（効果2の対象）と重ならないスロットを選ぶ。 */
const BOARD: MemoryBoardOverrides = {
  charactersBySlot: { BACK_LEFT: "CHAR_ROSIE_HUGHES" },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_FANTASY_SCULPTOR_ROSIE_FRONT_RIGHT_CRIT_DMG_UP",
    unitIds: ["ally:FRONT_RIGHT"],
    magnitude: 0.105,
    statMod: { stat: "CRITICAL_DAMAGE_BONUS", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_FANTASY_SCULPTOR_ROSIE_ROSIE_CRIT_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 0.03,
    statMod: { stat: "CRITICAL_RATE", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_FANTASY_SCULPTOR_ROSIE (空想造形師ロージー)", () => {
  it("IT-MEM-FANTASY-SCULPTOR-ROSIE-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
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
        filters: [{ kind: "CHARACTER", characterId: "CHAR_ROSIE_HUGHES" }],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [
          { kind: "POSITION_ROW", row: "FRONT" },
          { kind: "POSITION_COLUMN", column: "RIGHT" },
        ],
      },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。`grants`はID順、
    // `markers`は別配列なので適用順を表さないが、順序が入れ替わると
    // `EffectApplied`／`MarkerApplied`の発行順が変わり、それを契機にする連鎖が変わる。
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 0, actionIds: ["ACT_MEM_FANTASY_SCULPTOR_ROSIE_ROSIE_CRIT_UP"] },
      {
        triggeredEffectIndex: 1,
        actionIds: ["ACT_MEM_FANTASY_SCULPTOR_ROSIE_FRONT_RIGHT_CRIT_DMG_UP"],
      },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 会心率・会心ダメージボーナスはどちらもパーセントポイント加算（R-STA-01）。
    // ロージー（`ally:BACK_LEFT`）は基礎会心率0へ+3ppで0.03、右列前衛は
    // 基礎会心ダメージ0.5へ+10.5ppで0.605になる。対象外のスロットは基礎値のまま。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.criticalRate).toBeCloseTo(
        unit.battleUnitId === "ally:BACK_LEFT"
          ? MEMORY_COMBAT_STATS.criticalRate + 0.03
          : MEMORY_COMBAT_STATS.criticalRate,
        6,
      );
      expect(unit.combatStats.criticalDamageBonus).toBeCloseTo(
        unit.battleUnitId === "ally:FRONT_RIGHT"
          ? MEMORY_COMBAT_STATS.criticalDamageBonus + 0.105
          : MEMORY_COMBAT_STATS.criticalDamageBonus,
        6,
      );
    }
  });

  it("IT-MEM-FANTASY-SCULPTOR-ROSIE-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の同じスロットも同じキャラクターIDを名乗るが、ENEMY宣言では
    // 一切影響を受けない。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-FANTASY-SCULPTOR-ROSIE-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-FANTASY-SCULPTOR-ROSIE-004 (R-MEM-01): the CHARACTER-filtered triggeredEffect emits no MemoryTriggered when no ally is ロージー・ヒューズ, while the position-filtered one still resolves", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。既定盤面の
    // `characterId` は `CHAR_UNIT_TEST_MEMORY_<slot>` で、実キャラクターIDと
    // 一致しないため効果1だけが落ちる。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants).toEqual([EXPECTED_GRANTS[0]]);
  });

  it("IT-MEM-FANTASY-SCULPTOR-ROSIE-005 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
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

    // 右列前衛は自Memoryの会心ダメージ+10.5ppとハードな準備運動……？の前衛+4%が重なる。
    // 会心ダメージはパーセントポイント加算のため 0.5 + 0.105 = 0.605（R-STA-01）。
    expect(observed.statChanges["ally:FRONT_RIGHT"]).toEqual({
      attack: 1040,
      criticalDamageBonus: 0.605,
    });
    // ロージー（後衛左）はハードな準備運動……？の後衛+2.5%に加え、自Memoryの
    // 会心率+3ppが基礎値0へ加算されて現れる。
    expect(observed.statChanges["ally:BACK_LEFT"]).toEqual({ attack: 1025, criticalRate: 0.03 });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
