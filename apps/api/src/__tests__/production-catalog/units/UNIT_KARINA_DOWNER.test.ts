import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  turnCompleting,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_KARINA_DOWNER`（【ダウナーギャルな副委員長】カリナ・ジェンティーレ）の
 * ユニット単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_KARINA_DOWNER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const KEIBO = "MARKER_KEIBO";

/** EXゲージを持つ敵。0のままでは「EXゲージを1削る」が下限で消えて観測に載らない。 */
const ENEMIES_WITH_EX_GAUGE: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { currentExtraGauge: 3 },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentExtraGauge: 3 } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { currentExtraGauge: 3 },
  },
];

/** 「警棒」の所持数だけを変えた敵。増加率が段数に比例し3つで頭打ちになることを見る。 */
const ENEMIES_WITH_KEIBO: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    markers: [{ markerId: KEIBO, stackCount: 2 }],
  },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    markers: [{ markerId: KEIBO, stackCount: 5 }],
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** HP割合だけを変えた敵。「HPが多いほど高い効果」が線形に効くことを見る。 */
const ENEMIES_BY_HP_RATIO: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 10000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 5000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_EX",
    intent:
      "最も近い位置にいる敵単体、および対象に隣接する敵に対して威力124.8で攻撃し、2行動の間、行動時に攻撃力×7.5%の継続ダメージを受けるデバフを付与する。さらに2行動の間対象の攻撃力を30%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_EX" },
    expected: {
      // 最も近い敵は敵前列中央。隣接（上下左右）は enemy:left と enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -624,
        "enemy:left": -624,
        "enemy:back": -624,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          // 継続ダメージ量は付与時に付与者の攻撃力からsnapshotする（R-DOT-01）。
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          magnitude: 75,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          magnitude: 75,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_ATKDOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_EX_DOT",
          magnitude: 75,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_AS1",
    intent: "敵全体に威力53で攻撃し、EXゲージを1削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_AS1" },
    board: { enemies: ENEMIES_WITH_EX_GAUGE },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -265,
        "enemy:left": -265,
        "enemy:back": -265,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:left", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:back", resource: "EX_GAUGE", delta: -1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KARINA_DOWNER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_AS1",
    intent:
      "この攻撃によるダメージは、対象に付与されている「警棒」1つにつき15%増加する(最大3つまで)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_AS1" },
    board: { enemies: ENEMIES_WITH_KEIBO },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN",
          targets: ["enemy:left"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS1_EX_DOWN",
          targets: ["enemy:back"],
          resultKind: "SKIPPED",
        },
      ],
      // 265 の +30%（2つ）／+45%（5つは3つで頭打ち）／増加なし。
      hpDeltas: {
        "enemy:front": -344,
        "enemy:left": -384,
        "enemy:back": -265,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_KARINA_DOWNER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_AS2",
    intent:
      "自身から最も遠い位置にいる敵単体に威力140.4で攻撃し、2行動の間攻撃力を10%低下させる(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_KARINA_DOWNER_AS2" },
    expected: {
      // 前列中央の自身から最も遠いのは敵後列。
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_AS2_ATKDOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -702 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_AS2_ATKDOWN",
          magnitude: -0.1,
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
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent:
      "他の味方が後列の敵にアクティブスキルで攻撃される前に発動。自身に対しこの行動内で受けるデバフを無効にする効果を付与した後、攻撃してくる敵単体に対して「警棒」を1つ付与してこの行動内の攻撃力を25%低下させ(重複可)、行動が終了するまでの間攻撃を自身に引き寄せ肩代わりする。さらに後列の敵に対し、3行動の間攻撃力を10%低下させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "AS" }),
      triggeredBy: "enemy:back",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_SELF_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_MARK_ATTACKER",
          targets: ["enemy:back"],
        },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_ATTACKER_ATKDOWN",
          targets: ["enemy:back"],
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_REDIRECT", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_COVER", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_BACKROW_ATKDOWN",
          targets: ["enemy:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_SELF_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_ATTACKER_ATKDOWN",
          magnitude: -0.25,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_REDIRECT",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          // 肩代わり率（`damageShareRate`）がそのまま`magnitude`へ載る。
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_COVER",
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS1_BACKROW_ATKDOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      markers: [{ unitId: "enemy:back", markerId: KEIBO, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): 前列の敵からの攻撃では発動しない（「後列の敵に」攻撃される場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front", skillType: "AS" }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): 自身が攻撃される場合は発動しない（「他の味方が」攻撃される場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:subject", skillType: "AS" }),
      triggeredBy: "enemy:back",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): EXスキルで攻撃される場合は発動しない（「アクティブスキルで」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "EX" }),
      triggeredBy: "enemy:back",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
    intent: "(不成立): このスキルは自身のHPが40%未満の場合は発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS1",
      trigger: unitBeingAttacked({ source: "enemy:back", target: "ally:front", skillType: "AS" }),
      triggeredBy: "enemy:back",
    },
    board: { subject: { state: { currentHp: 3999 } } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_KARINA_DOWNER_PS2",
    intent:
      "ターン終了時に発動。敵全体に対し、次の攻撃での与ダメージを最高30%低下させるデバフを付与する(重複可)。このデバフは対象のHPが多いほど高い効果を発揮する。さらに味方全体に対し、1行動の間得られるEXゲージを50%増加させるバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_KARINA_DOWNER_PS2",
      trigger: turnCompleting({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: { enemies: ENEMIES_BY_HP_RATIO },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_EX_GAIN_UP",
          magnitude: 0.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        // 満HP（10000/10000）で上限の-30%、半分で-15%、2割で-6%。
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF",
          magnitude: -0.3,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF",
          magnitude: -0.15,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_KARINA_DOWNER_PS2_DEBUFF",
          magnitude: -0.06,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_KARINA_DOWNER (【ダウナーギャルな副委員長】カリナ・ジェンティーレ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-KARINA-DOWNER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-KARINA-DOWNER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-KARINA-DOWNER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
});
