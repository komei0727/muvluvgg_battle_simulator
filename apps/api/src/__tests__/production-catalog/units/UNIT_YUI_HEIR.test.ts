import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeCumulativeThresholdCounter } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardOverrides,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage } from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_YUI_HEIR`(【譜代武家・篁家次期当主】篁唯依)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_YUI_HEIR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const KENKI = "MARKER_YUI_HEIR_KENKI";

/** 会心を必ず発生させる盤面と抽選列。AS2の会心分岐の判別用。 */
const ALWAYS_CRITICAL: BoardOverrides = { combatStats: { criticalRate: 1 } };

function critical(): SequenceRandomSource {
  return new SequenceRandomSource(new Array<number>(64).fill(0));
}

/** EXが解除するシールドを実 production 定義で敵へ用意する。 */
const ENEMY_HAS_SHIELD: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_YUI_HEIR_PS2_SHIELD", target: "ENEMY" },
];

/** AS1のPP分岐が `elseSteps` を選ぶ盤面（対象のPPが3未満）。 */
const ENEMY_LOW_PP: BoardOverrides = {
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentPp: 2 } },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** 自身が「剣気」を保持している前提。AS2の威力が上がる腕を選ぶ。 */
const HOLDS_KENKI: BoardOverrides = {
  subject: { markers: [{ markerId: KENKI, stackCount: 1 }] },
};

/** PS2の契機。累計で最大HP×30%（3000）を超える被弾でカウンタが動く。 */
const HEAVY_HIT = realDamage({
  from: "enemy:front",
  to: "ally:subject",
  skillType: "AS",
  power: 7,
});

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_YUI_HEIR_EX",
    intent:
      "敵単体のシールドを全て解除し、さらにこのスキル内でのみ対象の防御力を最高50%低下させて（重複可）、威力243.8で攻撃する。防御力デバフは対象のHPが多いほど高い効果を発揮する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YUI_HEIR_EX" },
    precedingActions: ENEMY_HAS_SHIELD,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_EX_REMOVE_SHIELD", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_EX_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_EX_DAMAGE", targets: ["enemy:front"] },
      ],
      // HP割合50%の対象では最高値-50%の半分＝-25%。防御力500が375へ落ちた状態で
      // (1000-375)×243.8% を撃つ。
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_YUI_HEIR_EX_DEF_DOWN",
          magnitude: -0.25,
          timeLimit: { unit: "SKILL_USE", count: 1 },
        },
      ],
      effectsRemoved: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_YUI_HEIR_PS2_SHIELD",
          magnitude: 1500,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      hpDeltas: { "enemy:front": -1523 },
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_AS1",
    intent:
      "敵単体に威力74.2で3ヒット攻撃し、与えたダメージの30%分自身のHPを回復する。さらに対象のPPが3以上残っていた場合、PPを2削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YUI_HEIR_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS1_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS1_PP_DOWN", targets: ["enemy:front"] },
      ],
      // 1ヒット371の3ヒット。回復は最終ヒット371の30%＝111。
      hpDeltas: { "enemy:front": -1113, "ally:subject": 111 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "PP", delta: -2 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_YUI_HEIR_AS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_AS1",
    intent: "（対象のPPが3未満）PPを削る腕は選ばれない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YUI_HEIR_AS1" },
    board: ENEMY_LOW_PP,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS1_HEAL", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -1113, "ally:subject": 111 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_YUI_HEIR_AS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_AS2",
    intent: "このスキル内でのみ自身の会心率を10%上昇させ（重複可）、敵単体に威力171.6で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YUI_HEIR_AS2" },
    expected: {
      // 「剣気」も会心も無いため、基本の腕だけが走る。
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -858 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_AS2",
    intent:
      "この攻撃が会心攻撃になった場合、対象の次の攻撃での与ダメージを25%減少させるデバフを付与し、更に自身に対し「剣気」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YUI_HEIR_AS2" },
    board: ALWAYS_CRITICAL,
    random: critical,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_KENKI", targets: ["ally:subject"] },
      ],
      // 会心（基本1.5倍 + 会心ダメージ+50%）が乗って858の2倍。
      hpDeltas: { "enemy:front": -1716 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_YUI_HEIR_AS2_DMG_DOWN",
          magnitude: -0.25,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: KENKI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_AS2",
    intent:
      "攻撃時に「剣気」を所持している場合、この攻撃の威力は249.6になり、攻撃後に所持している「剣気」を全て解除する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YUI_HEIR_AS2" },
    board: HOLDS_KENKI,
    expected: {
      // 会心しなかったため与ダメージデバフと「剣気」再付与の腕は選ばれず、解除だけが走る。
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_DAMAGE_KENKI", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_AS2_CLEAR_KENKI", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -1248 },
      markersRemoved: [{ unitId: "ally:subject", markerId: KENKI, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_PS1",
    intent:
      "味方が後列の敵からアクティブスキルまたはパッシブスキルで攻撃された後に発動。攻撃してきた敵単体に対して威力212で反撃し、対象の次の攻撃での与ダメージを10%減少させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YUI_HEIR_PS1",
      trigger: realDamage({ from: "enemy:back", to: "ally:front", skillType: "AS" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_PS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_PS1_DMG_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -1060 },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_YUI_HEIR_PS1_DMG_DOWN",
          magnitude: -0.1,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_YUI_HEIR_PS1", remaining: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_PS1",
    intent: "(不成立): 前列の敵からの攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YUI_HEIR_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_PS1",
    intent: "(不成立): 後列の敵からでもEXスキルによる攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YUI_HEIR_PS1",
      trigger: realDamage({ from: "enemy:back", to: "ally:front", skillType: "EX" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_PS2",
    intent:
      "累計で最大HP×30%分のダメージを受けた際に発動。最もHP割合の低い敵単体に対して威力78で攻撃する。さらに自身に対し、最大HP×15%のシールドを付与する。シールドは1ヒット攻撃を受けると消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YUI_HEIR_PS2",
      trigger: HEAVY_HIT,
    },
    expected: {
      // 倒しきれないため回復の腕は選ばれない。
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_PS2_SHIELD", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -390 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YUI_HEIR_PS2_SHIELD",
          // 最大HP10000 × 15%。
          magnitude: 1500,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_PS2",
    intent: "この攻撃で対象を倒した場合、自身のHPを威力20で回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YUI_HEIR_PS2",
      trigger: HEAVY_HIT,
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 100 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YUI_HEIR_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_PS2_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YUI_HEIR_PS2_HEAL", targets: ["ally:subject"] },
      ],
      // 残HP100を削り切り、威力20の回復（攻撃力1000×20%）が入る。
      hpDeltas: { "enemy:front": -100, "ally:subject": 200 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YUI_HEIR_PS2_SHIELD",
          magnitude: 1500,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YUI_HEIR_PS2",
    intent: "(不成立): 累計被ダメージが最大HP×30%に届かない被弾では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YUI_HEIR_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_YUI_HEIR (【譜代武家・篁家次期当主】篁唯依)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-YUI-HEIR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-YUI-HEIR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-YUI-HEIR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-YUI-HEIR-004 (R-EFF-11): PS2 の累計ダメージ閾値counterは、閾値に届かない被弾では carry だけを動かし、実 catalog/ の trigger 条件がその RuntimeCounterChanged を valueChanged で弾く。ちょうど閾値・閾値2つぶんの被弾では公開値が動き、条件が成立する", () => {
    // `RuntimeCounterChanged` は carry だけが動いた被弾でも追跡のために発行される
    // （`14_Catalog定義スキーマ.md`「counterUpdates」）。条件側で判別できないと、
    // 閾値に達していない被弾のたびにPSが発動してしまう。
    expect(
      observeCumulativeThresholdCounter(snapshot, UNIT_DEFINITION_ID, "SKL_YUI_HEIR_PS2"),
    ).toEqual({
      declaration: {
        counter: "SKL_YUI_HEIR_PS2_CUMULATIVE_DAMAGE_RATIO",
        scope: "SKILL_RUNTIME",
        maxHpRatio: 0.3,
      },
      triggerEventType: "RuntimeCounterChanged",
      subThreshold: {
        changes: [
          {
            skillDefinitionId: "SKL_YUI_HEIR_PS2",
            counter: "SKL_YUI_HEIR_PS2_CUMULATIVE_DAMAGE_RATIO",
            before: 0,
            after: 0,
            valueChanged: false,
          },
        ],
        triggerMatched: false,
      },
      atThreshold: {
        changes: [
          {
            skillDefinitionId: "SKL_YUI_HEIR_PS2",
            counter: "SKL_YUI_HEIR_PS2_CUMULATIVE_DAMAGE_RATIO",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
        triggerMatched: true,
      },
      crossing: {
        changes: [
          {
            skillDefinitionId: "SKL_YUI_HEIR_PS2",
            counter: "SKL_YUI_HEIR_PS2_CUMULATIVE_DAMAGE_RATIO",
            before: 0,
            after: 2,
            valueChanged: true,
          },
        ],
        triggerMatched: true,
      },
    });
  });
});
