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
  observeMemoryEffectRemoval,
  observeMemoryGrants,
  observeMemoryTurnStarts,
} from "../../../testing/production-unit/memory-manifestation.js";
import { PRODUCTION_CATALOG_DIR } from "../../../testing/production-unit/skill-behaviour.js";
import { loadProductionSnapshot } from "../../../testing/fixtures/index.js";
import { runProductionPartyBattle } from "../../../testing/scenario/run-production-battle.js";

/**
 * `MEM_SURPRISE_OPERATION`（サプライズ大作戦！？）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1は戦闘開始時、敵全体へ属性に応じたデバフを配る（アグレッシブ・スマート・シャイ・
 * キュートは1行動の間の能力値低下、コミカルは次の攻撃の与ダメージ低下、クレバーは次に受ける
 * 攻撃の被ダメージ増加）。効果2は1ターン目のターン開始時だけ、1ターンの間敵全体の
 * HP回復量−7%。`MEM_PEACEFUL_DAYS`（穏やかな日々）と対象陣営・符号だけが逆の構成である。
 *
 * 6スロットへ6属性を1つずつ割り付け、各属性の効果がそのスロットにだけ当たることを固定する。
 * サブ属性を持つ敵はメイン・サブ両方の効果を受ける（R-ATR-04）。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_SURPRISE_OPERATION";

/** 前衛左は既定の`AGGRESSIVE`のまま、残り5スロットへ他の5属性を割り付ける。 */
const BOARD: MemoryBoardOverrides = {
  attributesBySlot: {
    FRONT_CENTER: "SMART",
    FRONT_RIGHT: "SHY",
    BACK_LEFT: "CUTE",
    BACK_CENTER: "COMICAL",
    BACK_RIGHT: "CLEVER",
  },
};

const ONE_ACTION = { unit: "ACTION", count: 1 } as const;

/** 戦闘開始時に発現する効果（EffectAction ID順）。 */
const EXPECTED_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_AGGRESSIVE_ATK_DOWN",
    unitIds: ["enemy:FRONT_LEFT"],
    magnitude: -1250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_AGGRESSIVE_SPD_DOWN",
    unitIds: ["enemy:FRONT_LEFT"],
    magnitude: -70,
    statMod: { stat: "ACTION_SPEED", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_CLEVER_DMG_TAKEN_UP",
    unitIds: ["enemy:BACK_RIGHT"],
    magnitude: 0.035,
    damageMod: { direction: "INCOMING", damageType: null },
    timeLimit: null,
    consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_COMICAL_DMG_DOWN",
    unitIds: ["enemy:BACK_CENTER"],
    magnitude: -0.035,
    damageMod: { direction: "OUTGOING", damageType: null },
    timeLimit: null,
    consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_CUTE_DEF_DOWN",
    unitIds: ["enemy:BACK_LEFT"],
    magnitude: -1000,
    statMod: { stat: "DEFENSE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_CUTE_SPD_DOWN",
    unitIds: ["enemy:BACK_LEFT"],
    magnitude: -70,
    statMod: { stat: "ACTION_SPEED", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_SHY_ATK_DOWN",
    unitIds: ["enemy:FRONT_RIGHT"],
    magnitude: -1250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_SHY_CRIT_DOWN",
    unitIds: ["enemy:FRONT_RIGHT"],
    magnitude: -0.05,
    statMod: { stat: "CRITICAL_RATE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_SMART_CRIT_DOWN",
    unitIds: ["enemy:FRONT_CENTER"],
    magnitude: -0.05,
    statMod: { stat: "CRITICAL_RATE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_SMART_DEF_DOWN",
    unitIds: ["enemy:FRONT_CENTER"],
    magnitude: -1000,
    statMod: { stat: "DEFENSE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
];

/** 1ターン目のターン開始時だけ発現する効果（敵全体）。 */
const EXPECTED_FIRST_TURN_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_SURPRISE_OPERATION_HEALING_DOWN",
    unitIds: [
      "enemy:FRONT_LEFT",
      "enemy:FRONT_CENTER",
      "enemy:FRONT_RIGHT",
      "enemy:BACK_LEFT",
      "enemy:BACK_CENTER",
      "enemy:BACK_RIGHT",
    ],
    magnitude: -0.07,
    healingMod: { direction: "INCOMING" },
    timeLimit: { unit: "TURN", count: 1, countGrantTurn: true },
    sourceSide: "ALLY",
  },
];

const attributeSelection = (triggeredEffectIndex: number, attribute: string) => ({
  triggeredEffectIndex,
  kind: "SELECT",
  side: "ENEMY",
  count: "ALL",
  filters: [{ kind: "ATTRIBUTE", attribute }],
});

/** 1ターン目の行動順キュー（ユニットごとの最初の予約の順）。 */
function firstTurnActionOrder(allyMemories: readonly string[]): readonly string[] {
  const result = runProductionPartyBattle(
    PRODUCTION_CATALOG_DIR,
    {
      ally: ["UNIT_SHIRANA_SORA"],
      enemy: ["UNIT_KOTOHA_DAILY", "UNIT_KEI_JACKKNIFE"],
      allyMemories,
    },
    { turnLimit: 1 },
  );
  const queue = result.events.find(
    (event) => event.type === "ACTION_QUEUE_CREATED" && event.turnNumber === 1,
  );
  expect(queue, "ACTION_QUEUE_CREATED of turn 1").toBeDefined();
  const reservations = (
    queue!.details as { readonly reservations: readonly { readonly battleUnitId: string }[] }
  ).reservations;
  return [...new Set(reservations.map((reservation) => reservation.battleUnitId))];
}

describe("production Catalog MEM_SURPRISE_OPERATION (サプライズ大作戦！？)", () => {
  it("IT-MEM-SURPRISE-OPERATION-001: at startBattle each attribute's debuffs land only on the enemy of that attribute, with the declared magnitudes and lifetimes", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.targetSelections).toEqual([
      attributeSelection(0, "AGGRESSIVE"),
      attributeSelection(1, "SMART"),
      attributeSelection(2, "SHY"),
      attributeSelection(3, "CUTE"),
      attributeSelection(4, "COMICAL"),
      attributeSelection(5, "CLEVER"),
      { triggeredEffectIndex: 6, kind: "SELECT", side: "ENEMY", count: "ALL", filters: [] },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。
    expect(observed.actionOrder).toEqual([
      {
        triggeredEffectIndex: 0,
        actionIds: [
          "ACT_MEM_SURPRISE_OPERATION_AGGRESSIVE_ATK_DOWN",
          "ACT_MEM_SURPRISE_OPERATION_AGGRESSIVE_SPD_DOWN",
        ],
      },
      {
        triggeredEffectIndex: 1,
        actionIds: [
          "ACT_MEM_SURPRISE_OPERATION_SMART_DEF_DOWN",
          "ACT_MEM_SURPRISE_OPERATION_SMART_CRIT_DOWN",
        ],
      },
      {
        triggeredEffectIndex: 2,
        actionIds: [
          "ACT_MEM_SURPRISE_OPERATION_SHY_ATK_DOWN",
          "ACT_MEM_SURPRISE_OPERATION_SHY_CRIT_DOWN",
        ],
      },
      {
        triggeredEffectIndex: 3,
        actionIds: [
          "ACT_MEM_SURPRISE_OPERATION_CUTE_DEF_DOWN",
          "ACT_MEM_SURPRISE_OPERATION_CUTE_SPD_DOWN",
        ],
      },
      { triggeredEffectIndex: 4, actionIds: ["ACT_MEM_SURPRISE_OPERATION_COMICAL_DMG_DOWN"] },
      { triggeredEffectIndex: 5, actionIds: ["ACT_MEM_SURPRISE_OPERATION_CLEVER_DMG_TAKEN_UP"] },
    ]);
    expect(observed.markers).toEqual([]);
    // 効果2（index 6）は`TurnStarted`発動なので`BattleStarted`では候補にならない。
    expect(observed.triggeredOrder).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `${MEMORY_DEFINITION_ID}#${i}`),
    );
    const stats = Object.fromEntries(
      observed.started.enemyUnits.map((unit) => [unit.battleUnitId, unit.combatStats]),
    );
    expect(stats["enemy:FRONT_LEFT"]).toMatchObject({
      attack: MEMORY_COMBAT_STATS.attack - 1250,
      actionSpeed: MEMORY_COMBAT_STATS.actionSpeed - 70,
    });
    expect(stats["enemy:FRONT_CENTER"]).toMatchObject({
      defense: MEMORY_COMBAT_STATS.defense - 1000,
      criticalRate: MEMORY_COMBAT_STATS.criticalRate - 0.05,
    });
    expect(stats["enemy:BACK_CENTER"]).toEqual(MEMORY_COMBAT_STATS);
  });

  it("IT-MEM-SURPRISE-OPERATION-002 (R-MEM-04): the same Memory declared by the ENEMY side lands both triggers on the mirrored slots", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ENEMY", 1, BOARD).turnStarts;
    expect(firstTurn?.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_FIRST_TURN_GRANTS));
  });

  it("IT-MEM-SURPRISE-OPERATION-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-SURPRISE-OPERATION-004 (R-ATR-04): an enemy whose sub attribute matches receives that attribute's debuffs on top of its main attribute's", () => {
    const grants = observeMemoryGrants(MEMORY_DEFINITION_ID, "ALLY", {
      ...BOARD,
      subAttributesBySlot: { BACK_RIGHT: "AGGRESSIVE" },
    });
    const holders = Object.fromEntries(
      grants.map((grant) => [grant.effectActionDefinitionId, grant.unitIds]),
    );
    expect(holders["ACT_MEM_SURPRISE_OPERATION_AGGRESSIVE_ATK_DOWN"]).toEqual([
      "enemy:FRONT_LEFT",
      "enemy:BACK_RIGHT",
    ]);
    expect(holders["ACT_MEM_SURPRISE_OPERATION_AGGRESSIVE_SPD_DOWN"]).toEqual([
      "enemy:FRONT_LEFT",
      "enemy:BACK_RIGHT",
    ]);
    expect(holders["ACT_MEM_SURPRISE_OPERATION_CLEVER_DMG_TAKEN_UP"]).toEqual(["enemy:BACK_RIGHT"]);
  });

  it("IT-MEM-SURPRISE-OPERATION-005 (R-EFF-06): the healing debuff is granted only at the start of turn 1 and expires at the end of that turn", () => {
    const { turnStarts } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2, BOARD);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    expect(turnStarts[0]?.grants).toEqual(EXPECTED_FIRST_TURN_GRANTS);
    expect(turnStarts[0]?.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#6`]);
    expect(turnStarts[1]?.grants).toEqual([]);
    expect(turnStarts[1]?.triggeredOrder).toEqual([]);
    const { battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD);
    const held = battle.enemyUnits.flatMap((unit) =>
      unit.appliedEffects.map((effect) => effect.effectActionDefinitionId as string),
    );
    expect(held).not.toContain("ACT_MEM_SURPRISE_OPERATION_HEALING_DOWN");
  });

  it("IT-MEM-SURPRISE-OPERATION-006: no memory-granted effect is removed by an unlimited BUFF/DEBUFF REMOVE_EFFECTS because every one is declared undispellable", () => {
    // メモリー由来の付与は解除不可（Issue #693）。
    const observed = observeMemoryEffectRemoval(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.heldBefore).toEqual(
      EXPECTED_GRANTS.map((grant) => grant.effectActionDefinitionId),
    );
    expect(observed.removed).toEqual([]);
    expect(observed.heldAfter).toEqual(observed.heldBefore);
  });

  it("IT-MEM-SURPRISE-OPERATION-007 (R-EFF-01): the one-action debuffs expire once their holder has acted, while the next-attack ones wait for their consumption", () => {
    // 固定盤面では誰も攻撃しないため、消費で失効する2件だけが1ターン目の後も残る。
    const { battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD);
    const held = Object.fromEntries(
      battle.enemyUnits.map((unit) => [
        unit.battleUnitId,
        unit.appliedEffects.map((effect) => effect.effectActionDefinitionId as string),
      ]),
    );
    expect(held).toEqual({
      "enemy:FRONT_LEFT": [],
      "enemy:FRONT_CENTER": [],
      "enemy:FRONT_RIGHT": [],
      "enemy:BACK_LEFT": [],
      "enemy:BACK_CENTER": ["ACT_MEM_SURPRISE_OPERATION_COMICAL_DMG_DOWN"],
      "enemy:BACK_RIGHT": ["ACT_MEM_SURPRISE_OPERATION_CLEVER_DMG_TAKEN_UP"],
    });
  });

  /**
   * 開始時の行動速度は KOTOHA_DAILY（敵・アグレッシブ、730）> KEI_JACKKNIFE（敵・スマート、725）
   * > SHIRANA_SORA（味方、711）。Memoryは行動順キュー生成前に解決されるため（R-MEM-03）、
   * アグレッシブのKOTOHA_DAILYだけが−70で末尾へ回り、スマートのKEI_JACKKNIFEは速度が
   * 変わらない。
   */
  it("IT-MEM-SURPRISE-OPERATION-008 (R-MEM-03): the action speed debuff reorders the first turn's action queue", () => {
    // 味方は ally:1（SHIRANA_SORA）。敵は前列左から enemy:1（KOTOHA_DAILY）、enemy:2（KEI_JACKKNIFE）。
    expect(firstTurnActionOrder([])).toEqual(["enemy:1", "enemy:2", "ally:1"]);
    expect(firstTurnActionOrder([MEMORY_DEFINITION_ID])).toEqual(["enemy:2", "ally:1", "enemy:1"]);
  });
});
