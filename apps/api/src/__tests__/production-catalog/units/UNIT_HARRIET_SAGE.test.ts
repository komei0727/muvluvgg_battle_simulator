import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeLifecycleDamageProbe } from "../../../testing/production-unit/damage-probe.js";
import { expireInstance } from "../../../testing/production-unit/effect-expiry.js";
import {
  PRODUCTION_CATALOG_DIR,
  applyPrecedingActions,
  collectedExecutedActionIds,
  observeSkillUse,
  productionBoard,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { chargeStarted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_HARRIET_SAGE`（【憎まれ口の大賢者】ハリエット・ミルズ）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_HARRIET_SAGE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const CURSE = "MARKER_CURSE";

/** 後列の味方だけHP割合を下げた配置（`LOWEST_HP_RATIO`が自身以外を選ぶ）。 */
const LOW_HP_BACK_ALLY: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
];

/** APに空きがある味方（「APを1加算し」が観測へ載る局面）。 */
const ALLY_WITH_AP_ROOM: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, state: { currentAp: 2 } },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_EX",
    intent:
      "味方全体のHPを威力50で回復する。さらに回復後の対象の不足HPの30%分を、2行動の間行動時に回復する効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HARRIET_SAGE_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_CONTINUOUS_HEAL",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_HEAL", targets: ["ally:front"] },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_CONTINUOUS_HEAL",
          targets: ["ally:front"],
        },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_HEAL", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_CONTINUOUS_HEAL", targets: ["ally:back"] },
      ],
      // 回復量は攻撃力1000×威力50%（R-HEAL-01は防御力を差し引かない）。
      hpDeltas: {
        "ally:subject": 500,
        "ally:front": 500,
        "ally:back": 500,
      },
      // 回復後の不足HP4500の30%。継続回復は「回復後の」状態を見る。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_CONTINUOUS_HEAL",
          magnitude: 1350,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_CONTINUOUS_HEAL",
          magnitude: 1350,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_EX_CONTINUOUS_HEAL",
          magnitude: 1350,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_AS1",
    intent:
      "自身に最も近い位置にいる敵単体と隣接する2体に対して威力85.8でEN攻撃し、対象に「カース」を1つ付与する。「カース」は1つにつき対象の攻撃力を7.5%低下させ、与ダメージを7.5%減少させる（重複可・解除不可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HARRIET_SAGE_AS1" },
    expected: {
      // 最も近い敵は敵前列。隣接（上下左右）は enemy:left と enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_MARKER", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -429,
        "enemy:left": -429,
        "enemy:back": -429,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [
        { unitId: "enemy:front", markerId: CURSE, stackCount: 1 },
        { unitId: "enemy:left", markerId: CURSE, stackCount: 1 },
        { unitId: "enemy:back", markerId: CURSE, stackCount: 1 },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HARRIET_SAGE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_AS1",
    intent:
      "この攻撃で対象が4つ目の「カース」を付与された場合、対象がその時点で所持しているPPを全て削り、「カース」を全て解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HARRIET_SAGE_AS1" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          markers: [{ markerId: CURSE, stackCount: 3 }],
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_MARKER", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_MARKER", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_PP_ZERO", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_REMOVE_CURSE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -429,
        "enemy:left": -429,
        "enemy:back": -429,
      },
      // 「カース」の攻撃力・与ダメージデバフは解除の対象外（解除不可）で、4つ目の
      // 分だけがここに現れる。
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          magnitude: -0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [
        { unitId: "enemy:left", markerId: CURSE, stackCount: 1 },
        { unitId: "enemy:back", markerId: CURSE, stackCount: 1 },
      ],
      // 4つ目を数えた「カース」は保持ごと無くなる（段数が減るのではない）。
      markersRemoved: [{ unitId: "enemy:front", markerId: CURSE, stackCount: 3 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "PP", delta: -4 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HARRIET_SAGE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_AS2",
    intent:
      "最もHP割合の低い味方単体に対して、2行動の間、現在HPの35%を超える攻撃のみ2ヒットまでダメージを無効にする効果を付与する。さらに行動時に威力13.5でHPを回復する効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HARRIET_SAGE_AS2" },
    board: { allies: LOW_HP_BACK_ALLY },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_IMMUNITY", targets: ["ally:back"] },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_CONTINUOUS_HEAL",
          targets: ["ally:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 2 },
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
          statusKind: "DAMAGE_IMMUNITY",
        },
        {
          // 継続回復のFormulaは発火のたびに評価するため、付与時点の`magnitude`は
          // 威力そのもの（R-HEAL-03）。
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_CONTINUOUS_HEAL",
          magnitude: 0.135,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_PS1",
    intent:
      "ターン開始時に発動。味方後列に対し、1ターンの間行動時に威力10.5でHPを回復する効果を付与する。さらに味方前列に対しても、1ターンの間行動時に威力10.5でHPを回復する効果を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HARRIET_SAGE_PS1",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      // 後列（ally:back）を先に、次に前列（自身と ally:front）を対象にする。
      actions: [
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL",
          targets: ["ally:back"],
        },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL",
          magnitude: 0.105,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL",
          magnitude: 0.105,
          timeLimit: { unit: "TURN", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_PS1_CONTINUOUS_HEAL",
          magnitude: 0.105,
          timeLimit: { unit: "TURN", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_PS2",
    intent:
      "他の味方がチャージスキルを使用した際に発動。チャージを開始した味方単体のAPを1加算し、1行動の間行動速度を100上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HARRIET_SAGE_PS2",
      trigger: chargeStarted({ actor: "ally:front", skillDefinitionId: "SKL_TEST_CHARGE" }),
      triggeredBy: "ally:front",
    },
    board: { allies: ALLY_WITH_AP_ROOM },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_PS2_AP_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_HARRIET_SAGE_PS2_SPEED_UP", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_PS2_SPEED_UP",
          magnitude: 100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:front", resource: "AP", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_PS2",
    intent: "(不成立): 自身のチャージ開始では発動しない（「他の」味方に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HARRIET_SAGE_PS2",
      trigger: chargeStarted({ actor: "ally:subject", skillDefinitionId: "SKL_TEST_CHARGE" }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_PS2",
    intent: "(不成立): 敵のチャージ開始では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HARRIET_SAGE_PS2",
      trigger: chargeStarted({ actor: "enemy:front", skillDefinitionId: "SKL_TEST_CHARGE" }),
      triggeredBy: "enemy:front",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_HARRIET_SAGE_AS1",
    intent: "同上: 敵が1体だけで隣接対象がいなくても、最も近い1体へは通常どおり発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HARRIET_SAGE_AS1" },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DAMAGE",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_MARKER",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -429,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
          magnitude: -0.075,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
          magnitude: -0.075,
          timeLimit: {
            unit: "BATTLE",
            count: 1,
          },
        },
      ],
      markers: [
        {
          unitId: "enemy:front",
          markerId: "MARKER_CURSE",
          stackCount: 1,
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
      cooldowns: [
        {
          unitId: "ally:subject",
          skillDefinitionId: "SKL_HARRIET_SAGE_AS1",
          remaining: 1,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_HARRIET_SAGE (【憎まれ口の大賢者】ハリエット・ミルズ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-HARRIET-SAGE-001: $skillDefinitionId — $intent",
    ({ use, board, precedingActions, random, expected }) => {
      expect(
        observeSkillUse({
          snapshot,
          unitDefinitionId: UNIT_DEFINITION_ID,
          use,
          ...(board === undefined ? {} : { board }),
          ...(precedingActions === undefined ? {} : { precedingActions }),
          ...(random === undefined ? {} : { random: random() }),
        }),
      ).toEqual(expected);
    },
  );

  it("IT-UNIT-HARRIET-SAGE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
    const unit = unitFrom(snapshot, UNIT_DEFINITION_ID);
    const declared = [
      ...unit.activeSkillDefinitionIds,
      ...unit.passiveSkillDefinitionIds,
      unit.extraSkillDefinitionId,
    ];
    expect([...new Set(BEHAVIOURS.map((entry) => entry.skillDefinitionId))].sort()).toEqual(
      [...declared].sort(),
    );
  });

  it("IT-UNIT-HARRIET-SAGE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
    resetExecutedActionIds();
    for (const { use, board, precedingActions, random } of BEHAVIOURS) {
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use,
        ...(board === undefined ? {} : { board }),
        ...(precedingActions === undefined ? {} : { precedingActions }),
        ...(random === undefined ? {} : { random: random() }),
      });
    }
    expect(
      unexecutedEffectActionIds(
        unitEffectActionClosure(snapshot, UNIT_DEFINITION_ID),
        collectedExecutedActionIds(),
      ),
    ).toEqual([]);
  });

  it("IT-UNIT-HARRIET-SAGE-004 [R-EFF-09] (R-EFF-09): AS1の攻撃力低下と与ダメージ低下は`HARRIET_CURSE_LINK`で連動し、片方が失効するともう片方も巻き添えで失効する", () => {
    // どちらも `timeLimit: { unit: BATTLE, count: 1 }` かつ `dispellable: false` で、
    // 実戦闘には失効させる契機が存在しない。連動そのものを見るために、片方1件だけを
    // 名指しで失効させる（契機の側は R-EFF-04/06/07・R-EFF-02 が持つ責務）。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    const granted = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN", target: "ENEMY" },
      { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN", target: "ENEMY" },
    ]);
    // 攻撃力7.5%低下が乗った状態（1000 → 925）。
    expect(granted.find((unit) => unit.battleUnitId === "enemy:front")!.combatStats.attack).toBe(
      925,
    );

    const expiry = expireInstance({
      units: granted,
      definitions: board.definitions,
      unitId: "enemy:front",
      effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
      reason: "TIME_LIMIT",
      battleId: "B_HARRIET_CURSE_LINK",
    });

    // 子を先に、親を後に発行する（`08_ドメインイベント.md`「EffectExpiredの順序」）。
    expect(expiry.expired).toEqual([
      {
        unitId: "enemy:front",
        effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_DMGDOWN",
        reason: "LINKED_GROUP_CASCADE",
        cascaded: true,
      },
      {
        unitId: "enemy:front",
        effectActionDefinitionId: "ACT_HARRIET_SAGE_AS1_ATKDOWN",
        reason: "TIME_LIMIT",
        cascaded: false,
      },
    ]);
    const after = expiry.units.find((unit) => unit.battleUnitId === "enemy:front")!;
    expect(after.appliedEffects).toEqual([]);
    expect(after.combatStats.attack).toBe(1000);
  });

  it("IT-UNIT-HARRIET-SAGE-005 [R-EFF-09] (R-EFF-09/R-EFF-07): AS2のダメージ無効が実被弾2回で消費し切って失効すると、`HARRIET_BARRIER`の子である継続回復も巻き添えで失効する — カスケードは親の失効理由に依存しない", () => {
    // `-004` の親は `TIME_LIMIT` で失効させたが、こちらの親は実ダメージpipelineの
    // 被弾で `CONSUMPTION` として失効する。カスケードの成立が親の失効理由に依らない
    // ことは、この2件を並べて初めて固定される。
    //
    // 誰が保持者になるか（最もHP割合の低い味方）は `-001` のAS2行が持つ責務なので、
    // ここは既定盤面のまま前提アクションが選ぶ味方をそのまま保持者にする。
    const board = productionBoard(snapshot, UNIT_DEFINITION_ID);
    let units = applyPrecedingActions(board, [
      { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_IMMUNITY", target: "ALLY" },
      { effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_CONTINUOUS_HEAL", target: "ALLY" },
    ]);
    const HOLDER = "ally:front";
    expect(
      units
        .find((unit) => unit.battleUnitId === HOLDER)!
        .appliedEffects.map((effect) => [
          effect.effectActionDefinitionId,
          effect.duration.consumptionRemaining,
        ]),
    ).toEqual([
      ["ACT_HARRIET_SAGE_AS2_IMMUNITY", 2],
      ["ACT_HARRIET_SAGE_AS2_CONTINUOUS_HEAL", undefined],
    ]);

    const expired: unknown[] = [];
    for (const hit of [1, 2]) {
      const probe = observeLifecycleDamageProbe({
        units,
        definitions: board.definitions,
        attackerUnitId: "enemy:front",
        targetUnitId: HOLDER,
        battleId: `B_HARRIET_BARRIER_HIT_${hit}`,
      });
      units = probe.units;
      expired.push(
        ...probe.recorder
          .getEvents()
          .filter((event) => event.eventType === "EffectExpired")
          .map((event) => ({
            unitId: event.payload.battleUnitId,
            effectActionDefinitionId: event.payload.effectActionDefinitionId,
            reason: event.payload.reason,
            cascaded: event.payload.cascaded === true,
          })),
      );
      // 1発目では消費が1残るだけで、どちらも失効しない。
      if (hit === 1) {
        expect(
          units
            .find((unit) => unit.battleUnitId === HOLDER)!
            .appliedEffects.map((effect) => effect.duration.consumptionRemaining),
        ).toEqual([1, undefined]);
        expect(expired).toEqual([]);
      }
    }

    expect(expired).toEqual([
      {
        unitId: HOLDER,
        effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_CONTINUOUS_HEAL",
        reason: "LINKED_GROUP_CASCADE",
        cascaded: true,
      },
      {
        unitId: HOLDER,
        effectActionDefinitionId: "ACT_HARRIET_SAGE_AS2_IMMUNITY",
        reason: "CONSUMPTION",
        cascaded: false,
      },
    ]);
    expect(units.find((unit) => unit.battleUnitId === HOLDER)!.appliedEffects).toEqual([]);
  });
});
