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
 * `MEM_PEACEFUL_DAYS`（穏やかな日々）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 効果1は戦闘開始時、味方全体へ属性に応じたバフを配る（アグレッシブ・スマート・シャイ・
 * キュートは1行動の間の能力値、コミカルは次の攻撃の与ダメージ、クレバーは次に受ける攻撃の
 * 被ダメージ）。効果2は1ターン目のターン開始時だけ、1ターンの間味方全体のHP回復量+7%。
 *
 * 6スロットへ6属性を1つずつ割り付け、各属性の効果がそのスロットにだけ当たることを固定する。
 * サブ属性を持つユニットはメイン・サブ両方の効果を受ける（R-ATR-04）。
 *
 * 表は全EffectAction IDを文字列リテラルで持つため、production全ID網羅監査
 * （`UT-AUDIT-UNITCOV-001`）の照合対象になる。
 */

const MEMORY_DEFINITION_ID = "MEM_PEACEFUL_DAYS";

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
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_AGGRESSIVE_ATK_UP",
    unitIds: ["ally:FRONT_LEFT"],
    magnitude: 1250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_AGGRESSIVE_SPD_UP",
    unitIds: ["ally:FRONT_LEFT"],
    magnitude: 70,
    statMod: { stat: "ACTION_SPEED", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_CLEVER_DMG_TAKEN_DOWN",
    unitIds: ["ally:BACK_RIGHT"],
    magnitude: -0.035,
    damageMod: { direction: "INCOMING", damageType: null },
    timeLimit: null,
    consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_COMICAL_DMG_UP",
    unitIds: ["ally:BACK_CENTER"],
    magnitude: 0.035,
    damageMod: { direction: "OUTGOING", damageType: null },
    timeLimit: null,
    consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_CUTE_DEF_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 1000,
    statMod: { stat: "DEFENSE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_CUTE_SPD_UP",
    unitIds: ["ally:BACK_LEFT"],
    magnitude: 70,
    statMod: { stat: "ACTION_SPEED", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_SHY_ATK_UP",
    unitIds: ["ally:FRONT_RIGHT"],
    magnitude: 1250,
    statMod: { stat: "ATTACK", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_SHY_CRIT_UP",
    unitIds: ["ally:FRONT_RIGHT"],
    magnitude: 0.05,
    statMod: { stat: "CRITICAL_RATE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_SMART_CRIT_UP",
    unitIds: ["ally:FRONT_CENTER"],
    magnitude: 0.05,
    statMod: { stat: "CRITICAL_RATE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_SMART_DEF_UP",
    unitIds: ["ally:FRONT_CENTER"],
    magnitude: 1000,
    statMod: { stat: "DEFENSE", valueType: "FIXED" },
    timeLimit: ONE_ACTION,
    sourceSide: "ALLY",
  },
];

/** 1ターン目のターン開始時だけ発現する効果。 */
const EXPECTED_FIRST_TURN_GRANTS: readonly MemoryGrant[] = [
  {
    effectActionDefinitionId: "ACT_MEM_PEACEFUL_DAYS_HEALING_UP",
    unitIds: [
      "ally:FRONT_LEFT",
      "ally:FRONT_CENTER",
      "ally:FRONT_RIGHT",
      "ally:BACK_LEFT",
      "ally:BACK_CENTER",
      "ally:BACK_RIGHT",
    ],
    magnitude: 0.07,
    healingMod: { direction: "INCOMING" },
    timeLimit: { unit: "TURN", count: 1, countGrantTurn: true },
    sourceSide: "ALLY",
  },
];

const attributeSelection = (triggeredEffectIndex: number, attribute: string) => ({
  triggeredEffectIndex,
  kind: "SELECT",
  side: "ALLY",
  count: "ALL",
  filters: [{ kind: "ATTRIBUTE", attribute }],
});

/** 1ターン目の行動順キュー（ユニットごとの最初の予約の順）。 */
function firstTurnActionOrder(allyMemories: readonly string[]): readonly string[] {
  const result = runProductionPartyBattle(
    PRODUCTION_CATALOG_DIR,
    {
      ally: ["UNIT_MIRIAM_MAGE", "UNIT_SHIRANA_SORA"],
      enemy: ["UNIT_MERU_FLATSPIN"],
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

/** 倍率の比較で浮動小数の加算順の差を吸収する。 */
function rounded(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** 実戦闘の1ヒット（`DAMAGE_WILL_BE_APPLIED`）と、Memory由来効果の失効（`EFFECT_EXPIRED`）の列。 */
type TraceEntry =
  | {
      readonly kind: "HIT";
      readonly hit: string;
      readonly outgoing: number;
      readonly incoming: number;
    }
  | {
      readonly kind: "EXPIRED";
      readonly effect: string;
      readonly unitId: string;
      readonly reason: string;
    };

/**
 * コミカル（MERU_FLATSPIN）・クレバー（YURIA_JOKER）を味方に置いた実戦闘の、ヒットと失効の列。
 * 相手もコミカル（LYDIA_GENIUS）・クレバー（OLGA_VETERAN）だが、このMemoryの対象陣営ではない。
 */
function consumptionTrace(allyMemories: readonly string[]): readonly TraceEntry[] {
  const result = runProductionPartyBattle(
    PRODUCTION_CATALOG_DIR,
    {
      ally: ["UNIT_MERU_FLATSPIN", "UNIT_YURIA_JOKER"],
      enemy: ["UNIT_LYDIA_GENIUS", "UNIT_OLGA_VETERAN"],
      allyMemories,
    },
    { turnLimit: 2 },
  );
  return result.events.flatMap((event): TraceEntry[] => {
    const details = event.details as Readonly<Record<string, unknown>>;
    if (event.type === "DAMAGE_WILL_BE_APPLIED") {
      return [
        {
          kind: "HIT",
          hit: `${String(details["skillDefinitionId"])}#${String(details["hitIndex"])}->${String(details["targetUnitId"])}`,
          outgoing: rounded(details["outgoingDamageMultiplier"] as number),
          incoming: rounded(details["incomingDamageMultiplier"] as number),
        },
      ];
    }
    if (
      event.type === "EFFECT_EXPIRED" &&
      String(details["effectActionDefinitionId"]).startsWith("ACT_MEM_")
    ) {
      return [
        {
          kind: "EXPIRED",
          effect: String(details["effectActionDefinitionId"]),
          unitId: String(details["battleUnitId"]),
          reason: String(details["reason"]),
        },
      ];
    }
    return [];
  });
}

describe("production Catalog MEM_PEACEFUL_DAYS (穏やかな日々)", () => {
  it("IT-MEM-PEACEFUL-DAYS-001: at startBattle each attribute's buffs land only on the ally of that attribute, with the declared magnitudes and lifetimes", () => {
    const observed = observeMemory(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.grants).toEqual(EXPECTED_GRANTS);
    expect(observed.targetSelections).toEqual([
      attributeSelection(0, "AGGRESSIVE"),
      attributeSelection(1, "SMART"),
      attributeSelection(2, "SHY"),
      attributeSelection(3, "CUTE"),
      attributeSelection(4, "COMICAL"),
      attributeSelection(5, "CLEVER"),
      { triggeredEffectIndex: 6, kind: "SELECT", side: "ALLY", count: "ALL", filters: [] },
    ]);
    // R-SKL-06 #4: 同じACTION stepの`actions`は定義順に適用される。
    expect(observed.actionOrder).toEqual([
      {
        triggeredEffectIndex: 0,
        actionIds: [
          "ACT_MEM_PEACEFUL_DAYS_AGGRESSIVE_ATK_UP",
          "ACT_MEM_PEACEFUL_DAYS_AGGRESSIVE_SPD_UP",
        ],
      },
      {
        triggeredEffectIndex: 1,
        actionIds: ["ACT_MEM_PEACEFUL_DAYS_SMART_DEF_UP", "ACT_MEM_PEACEFUL_DAYS_SMART_CRIT_UP"],
      },
      {
        triggeredEffectIndex: 2,
        actionIds: ["ACT_MEM_PEACEFUL_DAYS_SHY_ATK_UP", "ACT_MEM_PEACEFUL_DAYS_SHY_CRIT_UP"],
      },
      {
        triggeredEffectIndex: 3,
        actionIds: ["ACT_MEM_PEACEFUL_DAYS_CUTE_DEF_UP", "ACT_MEM_PEACEFUL_DAYS_CUTE_SPD_UP"],
      },
      { triggeredEffectIndex: 4, actionIds: ["ACT_MEM_PEACEFUL_DAYS_COMICAL_DMG_UP"] },
      { triggeredEffectIndex: 5, actionIds: ["ACT_MEM_PEACEFUL_DAYS_CLEVER_DMG_TAKEN_DOWN"] },
    ]);
    expect(observed.markers).toEqual([]);
    // 効果2（index 6）は`TurnStarted`発動なので`BattleStarted`では候補にならない。
    expect(observed.triggeredOrder).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `${MEMORY_DEFINITION_ID}#${i}`),
    );
    const stats = Object.fromEntries(
      observed.started.allyUnits.map((unit) => [unit.battleUnitId, unit.combatStats]),
    );
    expect(stats["ally:FRONT_LEFT"]).toMatchObject({
      attack: MEMORY_COMBAT_STATS.attack + 1250,
      actionSpeed: MEMORY_COMBAT_STATS.actionSpeed + 70,
    });
    expect(stats["ally:FRONT_CENTER"]).toMatchObject({
      defense: MEMORY_COMBAT_STATS.defense + 1000,
      criticalRate: MEMORY_COMBAT_STATS.criticalRate + 0.05,
    });
    expect(stats["ally:BACK_CENTER"]).toEqual(MEMORY_COMBAT_STATS);
  });

  it("IT-MEM-PEACEFUL-DAYS-002 (R-MEM-04): the same Memory declared by the ENEMY side lands both triggers on the mirrored slots", () => {
    expect(observeMemoryGrants(MEMORY_DEFINITION_ID, "ENEMY", BOARD)).toEqual(
      mirroredForEnemyDeclaration(EXPECTED_GRANTS),
    );
    const [firstTurn] = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ENEMY", 1, BOARD).turnStarts;
    expect(firstTurn?.grants).toEqual(mirroredForEnemyDeclaration(EXPECTED_FIRST_TURN_GRANTS));
  });

  it("IT-MEM-PEACEFUL-DAYS-003: every EffectAction this Memory declares was actually executed", () => {
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

  it("IT-MEM-PEACEFUL-DAYS-004 (R-ATR-04): an ally whose sub attribute matches receives that attribute's buffs on top of its main attribute's", () => {
    const grants = observeMemoryGrants(MEMORY_DEFINITION_ID, "ALLY", {
      ...BOARD,
      subAttributesBySlot: { BACK_RIGHT: "AGGRESSIVE" },
    });
    const holders = Object.fromEntries(
      grants.map((grant) => [grant.effectActionDefinitionId, grant.unitIds]),
    );
    expect(holders["ACT_MEM_PEACEFUL_DAYS_AGGRESSIVE_ATK_UP"]).toEqual([
      "ally:FRONT_LEFT",
      "ally:BACK_RIGHT",
    ]);
    expect(holders["ACT_MEM_PEACEFUL_DAYS_AGGRESSIVE_SPD_UP"]).toEqual([
      "ally:FRONT_LEFT",
      "ally:BACK_RIGHT",
    ]);
    expect(holders["ACT_MEM_PEACEFUL_DAYS_CLEVER_DMG_TAKEN_DOWN"]).toEqual(["ally:BACK_RIGHT"]);
  });

  it("IT-MEM-PEACEFUL-DAYS-005 (R-EFF-06): the healing buff is granted only at the start of turn 1 and expires at the end of that turn", () => {
    const { turnStarts } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 2, BOARD);
    expect(turnStarts.map((turn) => turn.turnNumber)).toEqual([1, 2]);
    expect(turnStarts[0]?.grants).toEqual(EXPECTED_FIRST_TURN_GRANTS);
    expect(turnStarts[0]?.triggeredOrder).toEqual([`${MEMORY_DEFINITION_ID}#6`]);
    expect(turnStarts[1]?.grants).toEqual([]);
    expect(turnStarts[1]?.triggeredOrder).toEqual([]);
    const { battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD);
    const held = battle.allyUnits.flatMap((unit) =>
      unit.appliedEffects.map((effect) => effect.effectActionDefinitionId as string),
    );
    expect(held).not.toContain("ACT_MEM_PEACEFUL_DAYS_HEALING_UP");
  });

  it("IT-MEM-PEACEFUL-DAYS-006: no memory-granted effect is removed by an unlimited BUFF/DEBUFF REMOVE_EFFECTS because every one is declared undispellable", () => {
    // メモリー由来の付与は解除不可（Issue #693）。
    const observed = observeMemoryEffectRemoval(MEMORY_DEFINITION_ID, "ALLY", BOARD);
    expect(observed.heldBefore).toEqual(
      EXPECTED_GRANTS.map((grant) => grant.effectActionDefinitionId),
    );
    expect(observed.removed).toEqual([]);
    expect(observed.heldAfter).toEqual(observed.heldBefore);
  });

  it("IT-MEM-PEACEFUL-DAYS-007 (R-EFF-01): the one-action buffs expire once their holder has acted, while the next-attack ones wait for their consumption", () => {
    // 固定盤面では誰も攻撃しないため、消費で失効する2件だけが1ターン目の後も残る。
    const { battle } = observeMemoryTurnStarts(MEMORY_DEFINITION_ID, "ALLY", 1, BOARD);
    const held = Object.fromEntries(
      battle.allyUnits.map((unit) => [
        unit.battleUnitId,
        unit.appliedEffects.map((effect) => effect.effectActionDefinitionId as string),
      ]),
    );
    expect(held).toEqual({
      "ally:FRONT_LEFT": [],
      "ally:FRONT_CENTER": [],
      "ally:FRONT_RIGHT": [],
      "ally:BACK_LEFT": [],
      "ally:BACK_CENTER": ["ACT_MEM_PEACEFUL_DAYS_COMICAL_DMG_UP"],
      "ally:BACK_RIGHT": ["ACT_MEM_PEACEFUL_DAYS_CLEVER_DMG_TAKEN_DOWN"],
    });
  });

  /**
   * 開始時の行動速度は MERU_FLATSPIN（敵、724）> SHIRANA_SORA（シャイ、711）>
   * MIRIAM_MAGE（アグレッシブ、682）。Memoryは行動順キュー生成前に解決されるため
   * （R-MEM-03）、アグレッシブのMIRIAM_MAGEだけが+70で先頭へ回り、シャイの
   * SHIRANA_SORAは速度が変わらない。
   */
  it("IT-MEM-PEACEFUL-DAYS-008 (R-MEM-03): the action speed buff reorders the first turn's action queue", () => {
    // 編成は前列左から ally:1（MIRIAM_MAGE）、ally:2（SHIRANA_SORA）。敵は enemy:1（MERU_FLATSPIN）。
    expect(firstTurnActionOrder([])).toEqual(["enemy:1", "ally:2", "ally:1"]);
    expect(firstTurnActionOrder([MEMORY_DEFINITION_ID])).toEqual(["ally:1", "enemy:1", "ally:2"]);
  });

  /**
   * Memoryの有無でヒットの並び（スキル・ヒット番号・対象）は変わらない。差はコミカルの
   * 最初の攻撃の与ダメージ倍率と、クレバーが最初に受けた攻撃の被ダメージ倍率だけで、
   * それぞれの直後に消費（`CONSUMPTION`）で失効し、以降のヒットは基準と一致する。
   */
  it("IT-MEM-PEACEFUL-DAYS-009 (R-EFF-01): the comical and clever effects modify exactly one attack each and are then consumed", () => {
    const baseline = consumptionTrace([]);
    expect(baseline.filter((entry) => entry.kind === "EXPIRED")).toEqual([]);
    const comicalHit = baseline.findIndex(
      (entry) =>
        entry.kind === "HIT" &&
        entry.hit.startsWith("SKL_MERU_FLATSPIN_") &&
        entry.hit.endsWith("->enemy:1"),
    );
    const cleverHit = baseline.findIndex(
      (entry) => entry.kind === "HIT" && entry.hit.endsWith("->ally:2"),
    );
    expect(comicalHit).toBeGreaterThanOrEqual(0);
    expect(cleverHit).toBeGreaterThanOrEqual(0);

    const expected = baseline.flatMap((entry, index): TraceEntry[] => {
      if (entry.kind !== "HIT") {
        return [entry];
      }
      if (index === comicalHit) {
        return [
          { ...entry, outgoing: rounded(entry.outgoing + 0.035) },
          {
            kind: "EXPIRED",
            effect: "ACT_MEM_PEACEFUL_DAYS_COMICAL_DMG_UP",
            unitId: "ally:1",
            reason: "CONSUMPTION",
          },
        ];
      }
      if (index === cleverHit) {
        return [
          { ...entry, incoming: rounded(entry.incoming - 0.035) },
          {
            kind: "EXPIRED",
            effect: "ACT_MEM_PEACEFUL_DAYS_CLEVER_DMG_TAKEN_DOWN",
            unitId: "ally:2",
            reason: "CONSUMPTION",
          },
        ];
      }
      return [entry];
    });
    expect(consumptionTrace([MEMORY_DEFINITION_ID])).toEqual(expected);
  });
});
