import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
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
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_OLGA_VETERAN`(【歴戦の鉄母】オルガ・ヴォルコワ)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_OLGA_VETERAN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const VIGILANCE = "MARKER_OLGA_VETERAN_VIGILANCE";

/** 自身を後列へ置き、味方前列を ally:front 1体だけにした盤面。AS1の後列分岐用。 */
const SUBJECT_IN_BACK_ROW = {
  subject: { position: { column: "CENTER", row: "BACK" } as const },
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
    { id: "ally:back", position: { column: "RIGHT", row: "BACK" } },
  ] as readonly BoardUnitSpec[],
};

/** PS1は「アクティブスキル4回目の使用」でだけ発動する。counterを3に置いて次を4回目にする。 */
const PS1_COUNTER_AT_THREE = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_OLGA_VETERAN_PS1")]: {
          [createRuntimeCounterId("SKL_OLGA_VETERAN_PS1_TRIGGER_COUNT")]: { value: 3, carry: 0 },
        },
      },
    },
  },
};

/** PS2は戦闘中1度しか発動しない。発動済みcounterを1に置いて不成立側を作る。 */
const PS2_ALREADY_ACTIVATED = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_OLGA_VETERAN_PS2")]: {
          [createRuntimeCounterId("SKL_OLGA_VETERAN_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_EX",
    intent:
      "敵全体に1行動の混乱を付与する。混乱はアクティブスキルで攻撃する際、本来の対象の逆陣営に攻撃を行う。この際のダメージは30%減少する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "CONFUSION",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_AS1",
    intent: "敵横一列に威力171.6でEN攻撃する。さらに与えた全ダメージの12.5%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_HEAL", targets: ["ally:subject"] },
      ],
      // 1体858（威力171.6%）×2体の合計1716の12.5%＝214（切り捨て）。
      hpDeltas: { "enemy:front": -858, "enemy:left": -858, "ally:subject": 214 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_VETERAN_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_AS1",
    intent:
      "自身が後列にいた場合味方前列にも威力25でEN攻撃するが、同時に対象のEXゲージを1追加し、1行動の間与ダメージを15%増加させる(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS1" },
    board: SUBJECT_IN_BACK_ROW,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_DAMAGE", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_EX_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_DMG_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_HEAL", targets: ["ally:subject"] },
      ],
      // 回復は味方前列へ与えた125も含めた総ダメージ1841の12.5%＝230（切り捨て）。
      hpDeltas: {
        "enemy:front": -858,
        "enemy:left": -858,
        "ally:front": -125,
        "ally:subject": 230,
      },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_AS1_ALLY_DMG_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:front", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_VETERAN_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
    intent:
      "敵単体に威力212でEN攻撃し、与えたダメージの17.5%分自身のHPを回復する。さらに対象に対し2行動の「警戒」を付与し、自身に対し2行動の間「警戒」を所持している敵から受ける攻撃の被ダメージを35%減少させる効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_OLGA_VETERAN_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_MARKER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 1060（威力212%）の17.5%＝185（切り捨て）。
      hpDeltas: { "enemy:front": -1060, "ally:subject": 185 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_AS2_DMG_DOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      markers: [{ unitId: "enemy:front", markerId: VIGILANCE, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
    intent:
      "自身がアクティブスキルを4回使用するたびに発動。自身に付与されているシールドとサブユニットをすべて解除し、自身の攻撃力をこのスキル中のみ30%上昇させて(重複可)、2行動の間、自身の最大HP×15%のHPを持ち、攻撃時に攻撃力×10.6%のENダメージを追加するサブユニット「カムラッドⅡ」を3つ付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_COUNTER_AT_THREE,
    // 解除対象のサブユニットを実 production 定義（PS2が配るカムラッドⅠ）で用意する。
    precedingActions: [
      { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", target: "SELF" },
    ],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_REMOVE_SHIELD_SUBUNIT",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_ATK_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS1_SUBUNIT",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
    intent: "(不成立): 1〜3回目の使用では発動しない(「4回使用するたび」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_OLGA_VETERAN_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
    intent:
      "ターン開始時に発動。自身の現在HPの60%を消費して、自身の最大HP×15%のHPを持ち、攻撃時に攻撃力×5.46%のENダメージを追加するサブユニット「カムラッドⅠ」を3つ付与する。さらに自身に対し、致死ダメージを1度だけ耐えてHPを最大HP×50%回復するバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_HP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
      ],
      // 現在HP5000の60%を消費。
      hpDeltas: { "ally:subject": -3000 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_SUBUNIT",
          magnitude: 1500,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_OLGA_VETERAN_PS2_DEATH_SURVIVAL",
          // 耐えた後のHPと回復量は消費時に評価するため、付与時点の効果量は持たない。
          magnitude: 0,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_OLGA_VETERAN_PS2", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_OLGA_VETERAN_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: PS2_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_OLGA_VETERAN (【歴戦の鉄母】オルガ・ヴォルコワ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-OLGA-VETERAN-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-OLGA-VETERAN-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-OLGA-VETERAN-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
