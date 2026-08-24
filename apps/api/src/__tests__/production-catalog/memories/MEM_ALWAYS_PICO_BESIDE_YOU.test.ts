import { describe, expect, it } from "vitest";
import { captureBattleState } from "../../../domain/battle/lifecycle/battle-state-snapshot.js";
import { reduceStateDeltas } from "../../../domain/battle/events/state-delta-reducer.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
import {
  memoryEffectActionClosure,
  unexecutedEffectActionIds,
} from "../../../testing/production-unit/definition-closure.js";
import {
  type MemoryGrant,
  type MemoryMarkerGrant,
  mirroredForEnemyDeclaration,
  mirroredMarkersForEnemyDeclaration,
  observeMemory,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_ALWAYS_PICO_BESIDE_YOU`（お傍にいるのはいつでもピコですよ♪）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1は中央列後衛へ攻撃力+3000を**1行動の間**与え、さらに「三ツ星」Markerを付与する。
 * 効果2は陣営全体へHP+300と防御力+300。全36Memoryのうち Marker を配る唯一の定義であり、
 * その Marker は付与者ユニットを持たない（R-MEM-04）。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_ALWAYS_PICO_BESIDE_YOU";
const MARKER_ID = "MARKER_MEM_ALWAYS_PICO_BESIDE_YOU_THREE_STARS";

const ALL_ALLY_SLOTS = [
  "ally:FRONT_LEFT",
  "ally:FRONT_CENTER",
  "ally:FRONT_RIGHT",
  "ally:BACK_LEFT",
  "ally:BACK_CENTER",
  "ally:BACK_RIGHT",
];

/** 期待する効果発現（EffectAction ID順）。盤面は`MEMORY_SLOTS`の6スロット×両陣営。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_ALL_DEF_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 300,
    statMod: { stat: "DEFENSE", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_ALL_HP_UP",
    unitIds: ALL_ALLY_SLOTS,
    magnitude: 300,
    statMod: { stat: "MAXIMUM_HP", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_BACK_CENTER_ATK_UP",
    unitIds: ["ally:BACK_CENTER"],
    magnitude: 3000,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_TARGET" },
    sourceSide: "ALLY",
  },
];

/** `ACT_MEM_ALWAYS_PICO_BESIDE_YOU_THREE_STARS` が配る「三ツ星」。 */
const EXPECTED_MARKERS: readonly MemoryMarkerGrant[] = [
  {
    markerId: MARKER_ID,
    unitIds: ["ally:BACK_CENTER"],
    stackCount: 1,
    // 原文は段数上限を書いていない（`stack.max: null`）。1回の付与では出ない宣言。
    stackMax: null,
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_ALWAYS_PICO_BESIDE_YOU (お傍にいるのはいつでもピコですよ♪)", () => {
  it("IT-MEM-ALWAYS-PICO-BESIDE-YOU-001: every EffectAction manifests on exactly the declared slots with the declared magnitude when the ALLY side brings the Memory", () => {
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
        filters: [
          { kind: "POSITION_ROW", row: "BACK" },
          { kind: "POSITION_COLUMN", column: "CENTER" },
        ],
      },
      { triggeredEffectIndex: 1, kind: "SELECT", side: "ALLY", count: "ALL", filters: [] },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。`grants`はID順、
    // `markers`は別配列なので適用順を表さないが、順序が入れ替わると
    // `EffectApplied`／`MarkerApplied`の発行順が変わり、それを契機にする連鎖が変わる。
    expect(observed.actionOrder).toEqual([
      {
        triggeredEffectIndex: 0,
        actionIds: [
          "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_BACK_CENTER_ATK_UP",
          "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_THREE_STARS",
        ],
      },
      {
        triggeredEffectIndex: 1,
        actionIds: [
          "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_ALL_HP_UP",
          "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_ALL_DEF_UP",
        ],
      },
    ]);
    expect(observed.markers).toEqual(EXPECTED_MARKERS);
    // R-MEM-02: `triggeredEffects` は定義順に、1件も飛ばさず解決される。
    expect(observed.triggeredOrder).toEqual([
      `${MEMORY_DEFINITION_ID}#0`,
      `${MEMORY_DEFINITION_ID}#1`,
    ]);
  });

  it("IT-MEM-ALWAYS-PICO-BESIDE-YOU-002 (R-MEM-04): the same Memory declared by the ENEMY side lands its buffs and its Marker on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ENEMY");
    expect(observed.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_GRANTS));
    expect(observed.markers).toEqual(mirroredMarkersForEnemyDeclaration(EXPECTED_MARKERS));
  });

  it("IT-MEM-ALWAYS-PICO-BESIDE-YOU-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-ALWAYS-PICO-BESIDE-YOU-004 [R-EFF-10, R-MEM-04] (R-MEM-04/R-EFF-10): the Marker and the one-action ATTACK buff both record a source side and no granter unit, and only the buff carries the ACTION time limit", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    const backCenter = observed.started.allyUnits.find(
      (unit) => unit.battleUnitId === "ally:BACK_CENTER",
    );

    const marker = backCenter?.markerStates[0];
    expect(marker?.markerId).toBe(MARKER_ID);
    expect(marker?.sourceUnitId).toBeUndefined();
    // 「1行動の間」は攻撃力バフだけに掛かる修飾で、「三ツ星」自体には期間の指定が
    // ないため戦闘終了まで残る。付与者ユニットを持たないため、付与者の戦闘不能で
    // 解除される経路（R-EFF-10）にも乗らない。
    expect(marker?.duration.definition.timeLimit).toEqual({ unit: "BATTLE", count: 1 });

    const attackBuff = backCenter?.appliedEffects.find(
      (effect) =>
        effect.effectActionDefinitionId === "ACT_MEM_ALWAYS_PICO_BESIDE_YOU_BACK_CENTER_ATK_UP",
    );
    expect(attackBuff?.sourceUnitId).toBeUndefined();
    // Memoryは付与者ユニットを持たないため、期間の所有者は効果の保持者自身になる。
    expect(attackBuff?.duration.definition.timeLimit).toEqual({
      unit: "ACTION",
      count: 1,
      owner: "EFFECT_TARGET",
    });
    expect(attackBuff?.duration.timeLimitRemaining).toBe(1);

    const markerApplied = observed.recorder
      .getEvents()
      .filter((event) => event.eventType === "MarkerApplied");
    expect(markerApplied).toHaveLength(1);
    expect(markerApplied[0]?.sourceUnitId).toBeUndefined();
    expect(markerApplied[0]?.sourceSide).toBe("ALLY");
  });

  it("IT-MEM-ALWAYS-PICO-BESIDE-YOU-005 [R-MEM-04]: the StateDeltas alone reconstruct the started battle, Marker and source side included", () => {
    // 独立Reducer復元: 開始前スナップショットへ`BattleStarted`以降のStateDeltaだけを
    // 適用すると、実際に開始した戦闘と同じ状態が再構成できる。
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY");
    const before = captureBattleState(observed.created);
    const after = captureBattleState(observed.started);
    const reconstructed = reduceStateDeltas(
      before,
      observed.recorder
        .getEvents()
        .flatMap((event) => (event.stateDelta === undefined ? [] : [event.stateDelta])),
    );

    expect(reconstructed).toEqual(after);
    expect(before).not.toEqual(after);
    const restored = reconstructed.units[createBattleUnitId("ally:BACK_CENTER")];
    expect(restored?.markers).toHaveLength(1);
    expect(restored?.markers?.[0]?.markerId).toBe(MARKER_ID);
    expect(restored?.markers?.[0]?.sourceUnitId).toBeUndefined();
    expect(restored?.markers?.[0]?.sourceSide).toBe("ALLY");
  });
});
