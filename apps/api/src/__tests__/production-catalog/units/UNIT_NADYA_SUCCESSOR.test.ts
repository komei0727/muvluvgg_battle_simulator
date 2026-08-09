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
  BOARD_COMBAT_STATS,
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  effectApplied,
  passiveActivated,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_NADYA_SUCCESSOR`(【輝ける次代の娘】ナージャ・ヴォルコワ)のユニット単位
 * production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_NADYA_SUCCESSOR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const TRAINING = "MARKER_NADYA_SUCCESSOR_TRAINING";
const MARK = "MARKER_NADYA_SUCCESSOR_MARK";

/** 攻撃力が1体だけ高い敵陣。EXの `HIGHEST_ATTACK` の判別用。 */
const ENEMY_WITH_HIGHEST_ATTACK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
  },
];

/** 行動速度が1体だけ速い敵陣。AS1の `FASTEST` の判別用。 */
const ENEMY_WITH_FASTEST: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, actionSpeed: 200 } },
  },
];

/**
 * 最速が既定対象（敵前列中央）と一致する敵陣。前提アクションの適用先（`ENEMY` は
 * `count: 1` + `DEFAULT`）とAS1の対象を同じ敵へ揃えるために使う。
 */
const ENEMY_FRONT_FASTEST: readonly BoardUnitSpec[] = [
  {
    id: "enemy:front",
    position: { column: "CENTER", row: "FRONT" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, actionSpeed: 200 } },
  },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 「研鑽」を3つ持ち、最速が既定対象と一致する盤面。AS1のBRANCH成立側を作る。 */
const SUBJECT_WITH_THREE_TRAINING = {
  subject: { markers: [{ markerId: TRAINING, stackCount: 3 }] },
  enemies: ENEMY_FRONT_FASTEST,
};

/** PS3は「パッシブスキル3回目の使用」でだけ発動する。counterを2に置いて次を3回目にする。 */
const PS3_COUNTER_AT_TWO = {
  subject: {
    state: {
      skillCounters: {
        [createSkillDefinitionId("SKL_NADYA_SUCCESSOR_PS3")]: {
          [createRuntimeCounterId("SKL_NADYA_SUCCESSOR_PS3_TRIGGER_COUNT")]: { value: 2, carry: 0 },
        },
      },
    },
  },
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_EX",
    intent:
      "攻撃力が最も高い敵単体に威力148.4で攻撃し、1行動の気絶を付与する。さらに自身に対し「研鑽」を1つと、2行動の間、自身の最大HP×25%のHPを持ち、攻撃時に攻撃力×23.4%のダメージを追加するサブユニット「ドルズィヤⅣ」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NADYA_SUCCESSOR_EX" },
    board: { enemies: ENEMY_WITH_HIGHEST_ATTACK },
    expected: {
      // EXが付与した気絶そのものがPS2（「敵に気絶が付与された際に発動」）の契機に
      // なるため、同じ行動の中でPS2が実際に走る。EX側の `EffectActionCompleted` は
      // このPS連鎖の後に確定する。
      actions: [
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_DAMAGE", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_TRAINING_MARK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_SUBUNIT", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_EX_STUN", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_EX_TRAINING_MARK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_EX_SUBUNIT", targets: ["ally:subject"] },
      ],
      // EX本体742（威力148.4%）とPS2の追撃390（威力78%）の合計。
      hpDeltas: { "enemy:back": -1132 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_SUBUNIT",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          // サブユニットの耐久力は付与時の最大HP10000の25%。
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_EX_SUBUNIT",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      // 「研鑽」はPS2の1つとEXの1つで2つになる。
      markers: [{ unitId: "ally:subject", markerId: TRAINING, stackCount: 2 }],
      // PS2の発動分。EX自身はEXゲージを全量消費する（この盤面では0のため差分なし）。
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_AS1",
    intent:
      "最も行動速度が速い敵単体に威力85.8で攻撃し、行動速度を15低下させ(重複可)、「メトカ」を1つ付与する。さらに自身に対し1行動の間、自身の最大HP×25%のHPを持ち、攻撃時に攻撃力×23.4%のダメージを追加するサブユニット「ドルズィヤⅠ」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NADYA_SUCCESSOR_AS1" },
    board: { enemies: ENEMY_WITH_FASTEST },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SPEED_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_MARK", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:back": -429 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SUBUNIT",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SPEED_DOWN",
          magnitude: -15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "enemy:back", markerId: MARK, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_AS1",
    intent:
      "対象に「メトカ」が付与されていた場合、1行動の間与ダメージを20%減少させるデバフを付与する(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NADYA_SUCCESSOR_AS1" },
    board: { enemies: ENEMY_FRONT_FASTEST },
    // 「メトカ」は実 production 定義（AS1自身が配るマーカー）で用意する。
    precedingActions: [
      { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_MARK", target: "ENEMY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SPEED_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_DMG_DOWN_DEBUFF",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_MARK", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -429 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SUBUNIT",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SPEED_DOWN",
          magnitude: -15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_DMG_DOWN_DEBUFF",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      // 前提で1つ載っているため、この使用の分と合わせて2つになる。
      markers: [{ unitId: "enemy:front", markerId: MARK, stackCount: 2 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_AS1",
    intent:
      "自身が所持している「研鑽」が3つ以上だった場合、この攻撃のダメージは50%増加し、攻撃後付与されている「研鑽」を全て解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NADYA_SUCCESSOR_AS1" },
    board: SUBJECT_WITH_THREE_TRAINING,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_DAMAGE_BOOSTED",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SPEED_DOWN",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_MARK", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SUBUNIT", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_CLEAR_TRAINING",
          targets: ["ally:subject"],
        },
      ],
      // 基礎429（威力85.8%）に与ダメージ+50%が乗って643（切り捨て）。
      hpDeltas: { "enemy:front": -643 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SUBUNIT",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_AS1_SPEED_DOWN",
          magnitude: -15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      // 自身の「研鑽」3つは解除されて差分に残らず、敵へ入った「メトカ」だけが増える。
      markers: [{ unitId: "enemy:front", markerId: MARK, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS1",
    intent:
      "自身に状態異常が付与された際に発動。自身に対し「研鑽」を1つと、1行動の間、自身の最大HP×35%のHPを持ち、攻撃時に攻撃力×31.2%のダメージを追加するサブユニット「ドルズィヤⅡ」を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STATUS",
        categories: ["STATUS"],
        statusKind: "STUN",
      }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS1_TRAINING_MARK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS1_SUBUNIT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS1_SUBUNIT",
          magnitude: 3500,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: TRAINING, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS1",
    intent: "(不成立): 他の味方への状態異常付与では発動しない(「自身に」付与された場合に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:front",
        effectKind: "APPLY_STATUS",
        categories: ["STATUS"],
        statusKind: "STUN",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS2",
    intent:
      "敵に気絶が付与された際に発動。付与された敵単体に威力78で攻撃する。さらに自身に対し「研鑽」1つと、1行動の間、自身の最大HP×25%のHPを持ち、攻撃時に攻撃力×42.4%のダメージを追加するサブユニット「ドルズィヤⅢ」を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS2",
      trigger: effectApplied({
        source: "ally:subject",
        target: "enemy:left",
        effectKind: "APPLY_STATUS",
        categories: ["STATUS"],
        statusKind: "STUN",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_DAMAGE", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_TRAINING_MARK",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_SUBUNIT", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:left": -390 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS2_SUBUNIT",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: TRAINING, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS2",
    intent: "(不成立): 気絶以外の状態異常が敵へ付与されても発動しない(「気絶が」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS2",
      trigger: effectApplied({
        source: "ally:subject",
        target: "enemy:left",
        effectKind: "APPLY_STATUS",
        categories: ["STATUS"],
        statusKind: "FREEZE",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS3",
    intent:
      "自身がパッシブスキルを3回使用するたびに発動。自身の攻撃力を7.5%、会心ダメージを7.5%上昇させる(重複可)。さらに味方全体の行動速度を30上昇させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS3",
      trigger: passiveActivated({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS1",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS3_COUNTER_AT_TWO,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_ATK_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_CRIT_DMG_UP",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_SPEED_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_SPEED_UP", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_ATK_UP",
          magnitude: 0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_CRIT_DMG_UP",
          magnitude: 0.075,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_SPEED_UP",
          magnitude: 30,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_SPEED_UP",
          magnitude: 30,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_NADYA_SUCCESSOR_PS3_SPEED_UP",
          magnitude: 30,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS3",
    intent: "(不成立): 1回目・2回目のパッシブ発動では発動しない(「3回使用するたび」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS3",
      trigger: passiveActivated({
        actor: "ally:subject",
        skillDefinitionId: "SKL_NADYA_SUCCESSOR_PS1",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_NADYA_SUCCESSOR (【輝ける次代の娘】ナージャ・ヴォルコワ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NADYA-SUCCESSOR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NADYA-SUCCESSOR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NADYA-SUCCESSOR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
