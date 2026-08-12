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
  observeMemory,
  observeMemoryGrants,
  observeMemoryTurnStarts,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_LIKE_FRIENDS`（友達みたいなこと）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1は**ターン開始時**に発動してコミカル属性・クレバー属性へ攻撃力+1000、
 * 効果2は戦闘開始時に発動して後衛へ与ダメージ+1.25%。発動契機の違う2件が
 * 1つのMemoryに同居するため、`-001` は戦闘開始時に効果1が出ないことを、
 * `-004` は毎ターン効果1だけが重ねて配られることを固定する。
 *
 * 効果1は原文が2属性を並べるため`OR`で束ねた単一のbindingにしてある。`ATTRIBUTE`は
 * `UnitDefinition`ではなく編成時に決まる`BattleUnit.attribute`を読むため、盤面の
 * 2スロットだけへ対象属性を持たせ、残る4スロット（既定の`AGGRESSIVE`）がそのまま
 * 非対象の検証になるようにする。
 *
 * 実`catalog/`の未改変定義を実`startBattle`（`BattleStarted`）から解決し、
 * この Memory が持つ全EffectActionが「どのスロットへ、どの効果量で」発現するかを
 * 下表で宣言する。表は全EffectAction IDを文字列リテラルで持つため、
 * production全ID網羅監査（`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_LIKE_FRIENDS";

/**
 * 対象属性は前衛左（コミカル）と後衛右（クレバー）の2スロットだけ。前衛と後衛へ
 * 1つずつ置くことで、効果1が属性ではなく行で絞れていた場合に落ちる。
 */
const BOARD: MemoryBoardOverrides = {
  attributesBySlot: { FRONT_LEFT: "COMICAL", BACK_RIGHT: "CLEVER" },
};

const BACK_ALLY_SLOTS = ["ally:BACK_LEFT", "ally:BACK_CENTER", "ally:BACK_RIGHT"];

/**
 * 戦闘開始時に発現する効果（EffectAction ID順）。`TurnStarted` 発動の効果1は
 * ここに現れない。盤面は`MEMORY_SLOTS`の6スロット×両陣営。
 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_LIKE_FRIENDS_BACK_DMG_UP",
    unitIds: BACK_ALLY_SLOTS,
    magnitude: 0.0125,
    damageMod: { direction: "OUTGOING", damageType: null },
    sourceSide: "ALLY",
  },
];

/** ターン開始ごとに発現する効果。 */
const EXPECTED_TURN_START_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_LIKE_FRIENDS_COMICAL_CLEVER_ATK_UP",
    unitIds: ["ally:FRONT_LEFT", "ally:BACK_RIGHT"],
    magnitude: 1000,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

describe("production Catalog MEM_LIKE_FRIENDS (友達みたいなこと)", () => {
  it("IT-MEM-LIKE-FRIENDS-001: only the BattleStarted triggeredEffect manifests at startBattle, on exactly the declared slots with the declared magnitude", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    // 対象集合の宣言。当たったスロットが1体だけの行では、`count: "ALL"`（対象と
    // なる陣営全員）が `count: 1` へ退行しても、絞り込みを同じ1体を引く別の
    // `filters` へ差し替えても `unitIds` は変わらない。宣言そのものを固定する。
    // 効果1の`OR`は「コミカルとクレバーの2属性」という原文をそのまま表す。
    expect(observed.targetSelections).toEqual([
      {
        triggeredEffectIndex: 0,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [
          {
            kind: "OR",
            conditions: [
              { kind: "ATTRIBUTE", attribute: "COMICAL" },
              { kind: "ATTRIBUTE", attribute: "CLEVER" },
            ],
          },
        ],
      },
      {
        triggeredEffectIndex: 1,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "POSITION_ROW", row: "BACK" }],
      },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。効果1は
    // `TurnStarted`発動なので、`BattleStarted`では`MemoryTriggered`ごと現れない。
    expect(observed.actionOrder).toEqual([
      { triggeredEffectIndex: 1, actionIds: ["ACT_MEM_LIKE_FRIENDS_BACK_DMG_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `triggeredEffects` は定義順に解決されるが、`TurnStarted` 発動の
    // 効果1（index 0）は`BattleStarted`では候補にならず、飛ばされる。
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    // 効果2は与ダメージ補正なので、戦闘開始時点でどのスロットの能力値も動かない。
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(MEMORY_COMBAT_STATS.attack);
    }
  });

  it("IT-MEM-LIKE-FRIENDS-002 (R-MEM-04): the same Memory declared by the ENEMY side lands both triggers on the mirrored slots and records ENEMY as the source side, never a granter unit", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
    // `TurnStarted` 発動の効果1は`startBattle`だけの観測に現れないため、
    // ターンを進めた側でも鏡像を取る（片方だけだと対象陣営や`sourceSide`の
    // 取り違えがALLY宣言でしか観測されない効果で見逃される）。
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ENEMY", 1, BOARD).turnStarts;
    expect(firstTurn?.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_TURN_START_GRANTS));
  });

  it("IT-MEM-LIKE-FRIENDS-003: every EffectAction this Memory declares was actually executed", () => {
    // 全ID網羅監査（`UT-AUDIT-UNITCOV-001`）は「IDが文字列として書かれているか」しか
    // 見ないため、表に載っているだけで一度も実行されない定義を見逃す。
    // `TurnStarted` 発動の効果は`startBattle`だけでは実行されないため、
    // ターンを進めた観測と合わせて閉包を埋める。
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    const executed = new Set([
      ...observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD).executedActionIds,
      ...observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD).turnStarts.flatMap(
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

  it("IT-MEM-LIKE-FRIENDS-004 (R-MEM-01): the TurnStarted triggeredEffect re-grants the ATTACK buff to both attributes on every turn while the BattleStarted one never repeats, and the grants accumulate", () => {
    const { turnStarts, battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2, BOARD);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    for (const turn of turnStarts) {
      // 効果2（`BattleStarted`）は`TurnStarted`の解決スコープには一切現れない。
      expect(turn.grants).toEqual(EXPECTED_TURN_START_GRANTS);
      expect(turn.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#0`]);
    }
    // 原文に期間の指定がないため、ターンごとの付与は失効せず積み上がる。
    for (const unit of battle.allyUnits) {
      const isTargetAttribute = ["ally:FRONT_LEFT", "ally:BACK_RIGHT"].includes(unit.battleUnitId);
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (isTargetAttribute ? 2000 : 0),
      );
    }
  });

  it("IT-MEM-LIKE-FRIENDS-005 (R-MEM-01): the TurnStarted triggeredEffect emits no MemoryTriggered when no ally carries COMICAL or CLEVER, while the back-row one still resolves at battle start", () => {
    // 境界（`08_ドメインイベント.md`「発動直前の再確認」）: 対象0件の
    // `triggeredEffect` は`MemoryTriggered`自体を発行しない。既定盤面は全スロットが
    // `AGGRESSIVE`なので、`OR`の両枝とも空振りする。
    const { turnStarts } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1);
    expect(turnStarts.map((turn) => turn.triggeredOrder)).toEqual([[]]);
    expect(turnStarts.map((turn) => turn.grants)).toEqual([[]]);
    // 属性で絞らない効果2は既定盤面でも変わらず配られる。
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ALLY")).toEqual(EXPECTED_GRANTS);
  });
});
