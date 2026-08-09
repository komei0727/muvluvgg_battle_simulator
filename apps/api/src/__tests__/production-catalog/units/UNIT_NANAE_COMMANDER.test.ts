import { describe, expect, it } from "vitest";
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
import { realDamage, turnCompleting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_NANAE_COMMANDER`(【オールラウンダーな統率者】鳴滝七彩)のユニット単位
 * production結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_NANAE_COMMANDER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 攻撃力が最も高い敵を前列の端に置く。同じ横一列に「他の敵」が居る形を作る。 */
const ENEMY_LEFT_HIGHEST_ATTACK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 同じ陣に、攻撃力が最も高い敵だけHP95%を持たせた版。気絶分岐の成立側を作る。 */
const ENEMY_LEFT_HIGHEST_ATTACK_NEARLY_FULL_HP: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  {
    id: "enemy:left",
    position: { column: "LEFT", row: "FRONT" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 }, currentHp: 9500 },
  },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 攻撃力が1体だけ高い敵陣。PS2の反撃先（`HIGHEST_ATTACK`）の判別用。 */
const ENEMY_BACK_HIGHEST_ATTACK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  {
    id: "enemy:back",
    position: { column: "CENTER", row: "BACK" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 } },
  },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_EX",
    intent:
      "敵全体の3行動の凍結を付与する。凍結状態中は全ての行動を行うことができない。ダメージを受けると凍結状態は解除されるが、その際の被ダメージが150%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_COMMANDER_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_EX_FREEZE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_EX_FREEZE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_EX_FREEZE", targets: ["enemy:back"] },
      ],
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 3 },
          statusKind: "FREEZE",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 3 },
          statusKind: "FREEZE",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 3 },
          statusKind: "FREEZE",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_AS1",
    intent:
      "自身に最も近い敵単体に対して5行動分の炎上を付与し、自身に隣接する味方に対して威力35でHPを回復する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_COMMANDER_AS1" },
    expected: {
      // 自身は敵前列中央の正面に居るため、最も近い敵は enemy:front。隣接する味方は
      // 直交隣接（左隣の ally:front と後ろの ally:back）。
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS1_BURN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS1_HEAL", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS1_HEAL", targets: ["ally:back"] },
      ],
      hpDeltas: { "ally:front": 350, "ally:back": 350 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS1_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_NANAE_COMMANDER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_AS2",
    intent:
      "攻撃力が最も高い敵が含まれる横一列に対し、威力93.6でEN攻撃する。さらに対象と同じ横一列にいる他の敵に対し、1行動の間攻撃力を10%低下させるデバフを付与する(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_COMMANDER_AS2" },
    board: { enemies: ENEMY_LEFT_HIGHEST_ATTACK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -468, "enemy:left": -468 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_AS2",
    intent: "さらに攻撃力が最も高い敵のHPが90%以上の場合、対象の敵単体に1行動分の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NANAE_COMMANDER_AS2" },
    board: { enemies: ENEMY_LEFT_HIGHEST_ATTACK_NEARLY_FULL_HP },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_STUN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -468, "enemy:left": -468 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_PS1",
    intent:
      "ターン終了時に発動。自身が含まれる味方前後列に対し、EN攻撃による被ダメージを3回まで30%減少させる効果と、2行動の間威力65でHPが回復するバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_COMMANDER_PS1",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      // 「自身が含まれる味方前後列」は自身と同じ列（CENTER）の自身と ally:back。
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL",
          // 継続回復は「威力65%」という宣言そのものを保持し、実額は発火時に決まる。
          magnitude: 0.65,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL",
          // 継続回復は「威力65%」という宣言そのものを保持し、実額は発火時に決まる。
          magnitude: 0.65,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_PS1",
    intent: "また自身が状態異常だった場合、自身にかけられたデバフを全て解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_COMMANDER_PS1",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    // 状態異常は炎上で作る（R-STS-01の状態異常はデバフの一種で、炎上・毒もそこに
    // 含まれる）。気絶・凍結を負ったユニットはPSそのものを発動できないため、
    // 「自身が状態異常だった場合」の分岐は行動を封じない状態異常でしか観測できない。
    // 解除対象のデバフはAS2の攻撃力低下。どちらも実 production 定義で用意する。
    precedingActions: [
      { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS1_BURN", target: "SELF" },
      { effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN", target: "SELF" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_CLEANSE", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL",
          magnitude: 0.65,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS1_HEAL",
          magnitude: 0.65,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      // 解除は `categories: ["DEBUFF"]` であり、状態異常（炎上）もデバフの一種として
      // 一緒に落ちる。自身へ入った被ダメージ減少・継続回復はバフのため残る。
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS1_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NANAE_COMMANDER_AS2_ATK_DOWN",
          magnitude: -0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_PS2",
    intent: "味方が攻撃を受けた直後に発動。攻撃力が最も高い敵単体に対し威力106でEN反撃する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_COMMANDER_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    board: { enemies: ENEMY_BACK_HIGHEST_ATTACK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NANAE_COMMANDER_PS2_COUNTER", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:back": -530 },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_NANAE_COMMANDER_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NANAE_COMMANDER_PS2",
    intent: "(不成立): 味方が与えた攻撃では発動しない(「味方が攻撃を受けた」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NANAE_COMMANDER_PS2",
      trigger: realDamage({ from: "ally:front", to: "enemy:front", skillType: "AS" }),
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_NANAE_COMMANDER (【オールラウンダーな統率者】鳴滝七彩)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NANAE-COMMANDER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NANAE-COMMANDER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NANAE-COMMANDER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
