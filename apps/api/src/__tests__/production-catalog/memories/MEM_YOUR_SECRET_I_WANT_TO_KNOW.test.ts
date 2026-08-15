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
 * `MEM_YOUR_SECRET_I_WANT_TO_KNOW`（知りたいキミの秘密）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * レイラ・ジェンキンスへ会心ダメージ+15%（効果1）と会心率+2.10%（効果2）。
 * どちらもパーセントポイント加算ステータスなので`valueType: FIXED`で表す
 * （R-STA-01）。両効果とも対象が同じ1キャラクターに閉じる初のMemoryである。
 *
 * `CHARACTER` TargetFilterは`UnitDefinition.metadata.characterId`を引く。固定盤面の
 * 既定IDは実キャラクターIDと一致しないため、1スロットだけへ`CHAR_LAYLA_JENKINS`を
 * 名乗らせ、残る5スロットがそのまま非対象の検証になるようにする。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_YOUR_SECRET_I_WANT_TO_KNOW";

/**
 * レイラは右列前衛に置く。`MEM_FANTASY_SCULPTOR_ROSIE`の会心ダメージ+10.5%と
 * 同じスロットになり、`-005`の重ね掛けが同一statで観測できる。
 */
const BOARD: MemoryBoardOverrides = {
  charactersBySlot: { FRONT_RIGHT: "CHAR_LAYLA_JENKINS" },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_YOUR_SECRET_I_WANT_TO_KNOW_LAYLA_CRIT_DMG_UP",
    unitIds: ["ally:FRONT_RIGHT"],
    magnitude: 0.15,
    statMod: { stat: "CRITICAL_DAMAGE_BONUS", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_YOUR_SECRET_I_WANT_TO_KNOW_LAYLA_CRIT_UP",
    unitIds: ["ally:FRONT_RIGHT"],
    magnitude: 0.021,
    statMod: { stat: "CRITICAL_RATE", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

/** 効果1・効果2が共有する対象宣言。原文はどちらも「レイラ・ジェンキンスの」。 */
const LAYLA_SELECTOR = {
  kind: "SELECT",
  side: "ALLY",
  count: "ALL",
  filters: [{ kind: "CHARACTER", characterId: "CHAR_LAYLA_JENKINS" }],
} as const;

describe("production Catalog MEM_YOUR_SECRET_I_WANT_TO_KNOW (知りたいキミの秘密)", () => {
  it("IT-MEM-YOUR-SECRET-I-WANT-TO-KNOW-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"`（対象と
    // なる陣営全員）が `count: 1` へ退行しても、絞り込みを同じ1体を引く別の
    // `filters` へ差し替えても `unitIds` は変わらない。宣言そのものを固定する。
    expect(observed.targetSelections).toEqual([
      { triggeredEffectIndex: 0, ...LAYLA_SELECTOR },
      { triggeredEffectIndex: 1, ...LAYLA_SELECTOR },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。`grants`はID順、
    // `markers`は別配列なので適用順を表さないが、順序が入れ替わると
    // `EffectApplied`／`MarkerApplied`の発行順が変わり、それを契機にする連鎖が変わる。
    expect(observed.actionOrder).toEqual([
      {
        triggeredEffectIndex: 0,
        actionIds: ["ACT_MEM_YOUR_SECRET_I_WANT_TO_KNOW_LAYLA_CRIT_DMG_UP"],
      },
      { triggeredEffectIndex: 1, actionIds: ["ACT_MEM_YOUR_SECRET_I_WANT_TO_KNOW_LAYLA_CRIT_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。両効果が
    // 同じ1体を引くため、ここが1件へ縮むと「原文2効果」が1効果へ退行したことになる。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 会心率・会心ダメージボーナスはどちらもパーセントポイント加算（R-STA-01）。
    // レイラ（`ally:FRONT_RIGHT`）は基礎会心率0へ+2.1ppで0.021、基礎会心ダメージ
    // 0.5へ+15ppで0.65になる。対象外のスロットは基礎値のまま。
    for (const unit of observed.started.allyUnits) {
      const isLayla = unit.battleUnitId === "ally:FRONT_RIGHT";
      expect(unit.combatStats.criticalRate).toBeCloseTo(
        isLayla ? MEMORY_COMBAT_STATS.criticalRate + 0.021 : MEMORY_COMBAT_STATS.criticalRate,
        6,
      );
      expect(unit.combatStats.criticalDamageBonus).toBeCloseTo(
        isLayla
          ? MEMORY_COMBAT_STATS.criticalDamageBonus + 0.15
          : MEMORY_COMBAT_STATS.criticalDamageBonus,
        6,
      );
    }
  });

  it("IT-MEM-YOUR-SECRET-I-WANT-TO-KNOW-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    // 味方陣営の同じスロットも同じキャラクターIDを名乗るが、ENEMY宣言では
    // 一切影響を受けない。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-YOUR-SECRET-I-WANT-TO-KNOW-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-YOUR-SECRET-I-WANT-TO-KNOW-004 (R-MEM-01): emits no MemoryTriggered at all when no ally is レイラ・ジェンキンス, because both triggeredEffects are gated on the same character", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。既定盤面の
    // `characterId` は `CHAR_UNIT_TEST_MEMORY_<slot>` で、実キャラクターIDと
    // 一致しないため、このMemoryは丸ごと何も配らない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([]);
    expect(observed.grants).toEqual([]);
    // 対象0件でも対象宣言そのものは定義順に残る（発動しなかった事実と、
    // 宣言が消えた事実を取り違えない）。
    expect(observed.targetSelections).toEqual([
      { triggeredEffectIndex: 0, ...LAYLA_SELECTOR },
      { triggeredEffectIndex: 1, ...LAYLA_SELECTOR },
    ]);
  });

  it("IT-MEM-YOUR-SECRET-I-WANT-TO-KNOW-005 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
    // 跨Memoryの解決順・同一スロットへの重ね掛け・複数Memory分をまとめたStateDelta
    // 復元は、複数Memoryを**同時に**編成したときにしか現れない。
    // 空想造形師ロージーはレイラと同じ右列前衛へ会心ダメージを重ね、ロージー本人
    // （後衛左）へは会心率を配るため、同一statの重ね掛けと別スロットへの独立付与を
    // 1回の観測で見分けられる。
    const board: MemoryBoardOverrides = {
      charactersBySlot: { FRONT_RIGHT: "CHAR_LAYLA_JENKINS", BACK_LEFT: "CHAR_ROSIE_HUGHES" },
    };
    const observed = observeCoDeclaredMemories(
      { ALLY: [MEMORY_DEFINITION_ID, "MEM_FANTASY_SCULPTOR_ROSIE"], ENEMY: ["MEM_STRANGERS"] },
      board,
    );

    // R-MEM-02: API指定順 → 同一Memory内の`triggeredEffects`定義順。ALLY候補を
    // すべて解決してからENEMY候補へ進む。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_FANTASY_SCULPTOR_ROSIE#0",
      "MEM_FANTASY_SCULPTOR_ROSIE#1",
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);
    // 宣言順を入れ替えると解決順も入れ替わる（ID順でも定義順でもなくAPI指定順である）。
    expect(
      observeCoDeclaredMemories(
        { ALLY: ["MEM_FANTASY_SCULPTOR_ROSIE", MEMORY_DEFINITION_ID], ENEMY: ["MEM_STRANGERS"] },
        board,
      ).triggeredOrder,
    ).toEqual([
      "MEM_FANTASY_SCULPTOR_ROSIE#0",
      "MEM_FANTASY_SCULPTOR_ROSIE#1",
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
      "MEM_STRANGERS#0",
      "MEM_STRANGERS#1",
    ]);

    // レイラ（右列前衛）は自Memoryの会心ダメージ+15ppと空想造形師ロージーの
    // +10.5ppが重なり、基礎0.5へ加算されて0.755。会心率は自Memoryの+2.1ppだけ。
    expect(observed.statChanges["ally:FRONT_RIGHT"]).toEqual({
      criticalRate: 0.021,
      criticalDamageBonus: 0.755,
    });
    // ロージー（後衛左）が受け取るのは空想造形師ロージーの会心率+3ppだけで、
    // このMemoryはキャラクターが違うため一切届かない。
    expect(observed.statChanges["ally:BACK_LEFT"]).toEqual({ criticalRate: 0.03 });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });
});
