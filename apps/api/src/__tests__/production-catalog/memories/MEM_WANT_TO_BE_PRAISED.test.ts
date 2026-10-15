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
  observeMemoryEffectRemoval,
  observeMemoryGrants,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_WANT_TO_BE_PRAISED`（褒められたい系女子）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 波瀬うるうへ会心率+3%、中央列後衛へ会心ダメージ+10.5%。`MEM_FANTASY_SCULPTOR_ROSIE` と
 * 同型で、原文は特定バリアントを指定しないため、全うるう（`UNIT_URUU_*`）が共有する
 * `CHAR_URUU_HASE` で絞る。固定盤面の既定IDは実キャラクターIDと一致しないため、
 * 1スロットだけへ `CHAR_URUU_HASE` を名乗らせ、残る5スロットがそのまま非対象の
 * 検証になるようにする。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_WANT_TO_BE_PRAISED";

/** うるうは前衛左に置く。中央列後衛（効果2の対象）と重ならないスロットを選ぶ。 */
const BOARD: MemoryBoardOverrides = {
  charactersBySlot: { FRONT_LEFT: "CHAR_URUU_HASE" },
};

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_WANT_TO_BE_PRAISED_BACK_CENTER_CRIT_DMG_UP",
    unitIds: ["ally:BACK_CENTER"],
    magnitude: 0.105,
    statMod: { stat: "CRITICAL_DAMAGE_BONUS", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_WANT_TO_BE_PRAISED_URUU_CRIT_UP",
    unitIds: ["ally:FRONT_LEFT"],
    magnitude: 0.03,
    statMod: { stat: "CRITICAL_RATE", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_WANT_TO_BE_PRAISED (褒められたい系女子)", () => {
  it("IT-MEM-WANT-TO-BE-PRAISED-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
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
        filters: [{ kind: "CHARACTER", characterId: "CHAR_URUU_HASE" }],
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
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 0, actionIds: ["ACT_MEM_WANT_TO_BE_PRAISED_URUU_CRIT_UP"] },
      {
        triggeredEffectIndex: 1,
        actionIds: ["ACT_MEM_WANT_TO_BE_PRAISED_BACK_CENTER_CRIT_DMG_UP"],
      },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
    // 会心率・会心ダメージボーナスはどちらもパーセントポイント加算（R-STA-01）。
    // うるう（`ally:FRONT_LEFT`）は基礎会心率0へ+3ppで0.03、中央列後衛は
    // 基礎会心ダメージ0.5へ+10.5ppで0.605になる。対象外のスロットは基礎値のまま。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.criticalRate).toBeCloseTo(
        unit.battleUnitId === "ally:FRONT_LEFT"
          ? MEMORY_COMBAT_STATS.criticalRate + 0.03
          : MEMORY_COMBAT_STATS.criticalRate,
        6,
      );
      expect(unit.combatStats.criticalDamageBonus).toBeCloseTo(
        unit.battleUnitId === "ally:BACK_CENTER"
          ? MEMORY_COMBAT_STATS.criticalDamageBonus + 0.105
          : MEMORY_COMBAT_STATS.criticalDamageBonus,
        6,
      );
    }
  });

  it("IT-MEM-WANT-TO-BE-PRAISED-002 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
  });

  it("IT-MEM-WANT-TO-BE-PRAISED-003: every EffectAction this Memory declares was actually executed", () => {
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    expect(
      unexecutedEffectActionIds(
        memoryEffectActionClosure(snapshot, MEMORY_DEFINITION_ID),
        new Set(observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD).executedActionIds),
      ),
    ).toEqual([]);
  });

  it("IT-MEM-WANT-TO-BE-PRAISED-004 (R-MEM-01): the CHARACTER-filtered triggeredEffect emits no MemoryTriggered when no ally is 波瀬うるう, while the position-filtered one still resolves", () => {
    // 対象0件の `triggeredEffect` は`MemoryTriggered`自体を発行しない。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.grants).toEqual([EXPECTED_GRANTS[0]]);
  });

  it("IT-MEM-WANT-TO-BE-PRAISED-005 (R-MEM-02): keeps its API-declared slot in the resolution order when other Memories are brought alongside it, stacks onto the same slots, and its StateDeltas alone still reconstruct the started battle", () => {
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

    // うるう（前衛左）はハードな準備運動……？の前衛+4%に加え、自Memoryの
    // 会心率+3ppが基礎値0へ加算されて現れる。
    expect(observed.statChanges["ally:FRONT_LEFT"]).toEqual({ attack: 1040, criticalRate: 0.03 });
    // 中央列後衛は自Memoryの会心ダメージ+10.5ppとハードな準備運動……？の後衛+2.5%が重なる。
    expect(observed.statChanges["ally:BACK_CENTER"]).toEqual({
      attack: 1025,
      criticalDamageBonus: 0.605,
    });

    // 独立Reducer復元: 開始前スナップショットへStateDeltaだけを当てると開始後状態になる。
    expect(observed.stateFromDeltas).toEqual(observed.stateAfter);
    expect(observed.stateBefore).not.toEqual(observed.stateAfter);
  });

  it("IT-MEM-WANT-TO-BE-PRAISED-006: no memory-granted effect is removed by an unlimited BUFF/DEBUFF REMOVE_EFFECTS because every one is declared undispellable", () => {
    // メモリー由来の付与は解除不可（Issue #693）。付与が戦闘開始時＝最古のため、
    // 解除可能だと`maxRemovals`付きの解除に優先的に剥がされる。
    const observed = observeMemoryEffectRemoval(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.heldBefore).toEqual([
      "ACT_MEM_WANT_TO_BE_PRAISED_BACK_CENTER_CRIT_DMG_UP",
      "ACT_MEM_WANT_TO_BE_PRAISED_URUU_CRIT_UP",
    ]);
    expect(observed.removed).toEqual([]);
    expect(observed.heldAfter).toEqual(observed.heldBefore);
  });
});
