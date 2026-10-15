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
  observeMemoryTurnStarts,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";

/**
 * `MEM_RECLAIMED_SCHOOL_LIFE`（取り返した学園生活）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1: 2の倍数ターンのターン開始時、`AFF_SIRIUS_SUGAR`に所属する味方の最大APを
 * 1ターンの間+1。既に所持APが6の対象には無効。
 * 効果2: 戦闘開始時、中央列前衛の味方の攻撃力+1500。
 *
 * ターン開始時のAP回復（`06_戦闘状態遷移.md` TURN_STARTING #2）は`TurnStarted`の
 * 解決より先に済むため、上限だけを上げてもそのターンの所持APは増えない。偶数ターンに
 * 実際にAPが1多く使えるよう、`raiseCurrent`で上限の増加分だけ所持APも増やし、
 * `countGrantTurn`で付与したターンの終了時に失効させる（奇数ターンは素の最大AP）。
 * 所持APの判定も回復しきった値を読むため、既定盤面（最大AP3）では無効条件が
 * 成立しない。`maximumApBySlot`で所持AP6を作って検証する。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_RECLAIMED_SCHOOL_LIFE";

/** 所属メンバーは前衛左と後衛右。前衛中央（効果2の対象）は所属を持たない。 */
const BOARD: MemoryBoardOverrides = {
  affiliationsBySlot: {
    FRONT_LEFT: ["AFF_SIRIUS_SUGAR"],
    BACK_RIGHT: ["AFF_SIRIUS_SUGAR"],
  },
};

const SIRIUS_SUGAR_ALLY_SLOTS = ["ally:FRONT_LEFT", "ally:BACK_RIGHT"];

const BASE_MAXIMUM_AP = 3;

const EXPECTED_BATTLE_START_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_RECLAIMED_SCHOOL_LIFE_FRONT_CENTER_ATK_UP",
    unitIds: ["ally:FRONT_CENTER"],
    magnitude: 1500,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    sourceSide: "ALLY",
  },
];

const EXPECTED_EVEN_TURN_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_RECLAIMED_SCHOOL_LIFE_SIRIUS_SUGAR_MAX_AP_UP",
    unitIds: SIRIUS_SUGAR_ALLY_SLOTS,
    magnitude: 1,
    sourceSide: "ALLY",
    timeLimit: { unit: "TURN", count: 1, countGrantTurn: true },
  },
];

describe("production Catalog MEM_RECLAIMED_SCHOOL_LIFE (取り返した学園生活)", () => {
  it("IT-MEM-RECLAIMED-SCHOOL-LIFE-001: only the front-center attack buff manifests at startBattle; the max-AP effect waits for an even turn start", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_BATTLE_START_GRANTS);
    expect(observed.markers).toEqual([]);
    // R-MEM-02: `TurnStarted` 発動の#0は `BattleStarted` では候補にならない。
    expect(observed.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#1`]);
    expect(observed.targetSelections).toEqual([
      {
        triggeredEffectIndex: 0,
        kind: "SELECT",
        side: "ALLY",
        count: "ALL",
        filters: [{ kind: "AFFILIATION", affiliationId: "AFF_SIRIUS_SUGAR" }],
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
    for (const unit of observed.started.allyUnits) {
      expect(unit.combatStats.attack).toBe(
        MEMORY_COMBAT_STATS.attack + (unit.battleUnitId === "ally:FRONT_CENTER" ? 1500 : 0),
      );
    }
  });

  it("IT-MEM-RECLAIMED-SCHOOL-LIFE-002: the max-AP effect fires only at even turn starts, on exactly the Sirius Sugar members", () => {
    const { turnStarts } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 4, BOARD);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2, 3, 4]);
    expect(turnStarts.map((turn) => turn.grants)).toEqual([
      [],
      EXPECTED_EVEN_TURN_GRANTS,
      [],
      EXPECTED_EVEN_TURN_GRANTS,
    ]);
    expect(turnStarts.map((turn) => turn.triggeredOrder)).toEqual([
      [],
      [`${MEMORY_DEFINITION_ID}#0`],
      [],
      [`${MEMORY_DEFINITION_ID}#0`],
    ]);
  });

  it("IT-MEM-RECLAIMED-SCHOOL-LIFE-003 (R-MEM-04): the same Memory declared by the ENEMY side lands on the mirrored slots and records ENEMY as the source side", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ENEMY", BOARD);
    expect(observed.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_BATTLE_START_GRANTS));
    const [, secondTurn] = observeMemoryTurnStarts(
      MEMORY_DEFINITION_ID,
      "ENEMY",
      2,
      BOARD,
    ).turnStarts;
    expect(secondTurn?.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_EVEN_TURN_GRANTS));
  });

  it("IT-MEM-RECLAIMED-SCHOOL-LIFE-004: every EffectAction this Memory declares was actually executed", () => {
    const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [], [MEMORY_DEFINITION_ID]);
    const executed = new Set([
      ...observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD).executedActionIds,
      ...observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2, BOARD).turnStarts.flatMap(
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

  it("IT-MEM-RECLAIMED-SCHOOL-LIFE-005 (R-EFF-06 countGrantTurn): Sirius Sugar members hold one extra AP (current and maximum) during turns 2 and 4 only", () => {
    const { turnStarts, battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 4, BOARD);
    for (const turn of turnStarts) {
      const siriusAp = BASE_MAXIMUM_AP + (turn.turnNumber % 2 === 0 ? 1 : 0);
      for (const [unitId, ap] of Object.entries(turn.allyApAtTurnStart)) {
        const expected = SIRIUS_SUGAR_ALLY_SLOTS.includes(unitId) ? siriusAp : BASE_MAXIMUM_AP;
        expect(ap, `${unitId} at turn ${turn.turnNumber}`).toEqual({
          current: expected,
          maximum: expected,
        });
      }
    }
    // 付与したターン（4）の終了時に失効し、上限は基準へ戻る。
    for (const unit of battle.allyUnits) {
      expect(unit.maximumAp).toBe(BASE_MAXIMUM_AP);
      expect(unit.currentAp).toBeLessThanOrEqual(BASE_MAXIMUM_AP);
    }
  });

  it("IT-MEM-RECLAIMED-SCHOOL-LIFE-006: a Sirius Sugar member already holding 6 AP at the turn start is skipped, while one holding 5 gains the extra AP", () => {
    const [, secondTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2, {
      ...BOARD,
      maximumApBySlot: { FRONT_LEFT: 6, BACK_RIGHT: 5 },
    }).turnStarts;
    expect(secondTurn?.grants).toEqual([
      { ...EXPECTED_EVEN_TURN_GRANTS[0], unitIds: ["ally:BACK_RIGHT"] },
    ]);
    expect(secondTurn?.allyApAtTurnStart["ally:FRONT_LEFT"]).toEqual({ current: 6, maximum: 6 });
    expect(secondTurn?.allyApAtTurnStart["ally:BACK_RIGHT"]).toEqual({ current: 6, maximum: 6 });
  });
});
