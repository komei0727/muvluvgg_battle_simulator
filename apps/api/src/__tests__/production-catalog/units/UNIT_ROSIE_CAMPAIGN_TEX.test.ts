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
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, unitBeingAttacked } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_ROSIE_CAMPAIGN_TEX`（破壊：ロージー・ヒューズ・戦術演習版）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * このユニットは戦術演習の敵専用（`category: EXERCISE_ENEMY`、R-TEX-11）で、原文は
 * ゲーム内スクリーンショットからの転記（Issue #667に引用）。プレイアブル版
 * `UNIT_ROSIE_CAMPAIGN` との差分はLv200固定ステータスに加え、**HP割合系の効果値が
 * 約1/20に縮小**されている点（威力・ライフスティール率・ステータス上昇率・被ダメ
 * 減少率などの攻撃力依存の数値は据え置き）。
 */

const UNIT_DEFINITION_ID = "UNIT_ROSIE_CAMPAIGN_TEX";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const CREATION = "MARKER_ROSIE_CAMPAIGN_TEX_CREATION";
const IDEA = "MARKER_ROSIE_CAMPAIGN_TEX_IDEA";

/** 自身のHPを最大HPの10%（1000）へ落とし、PS2の発動条件（HP割合20%未満）を満たす。 */
const LOW_HP: SkillBehaviourCase["board"] = { subject: { state: { currentHp: 1000 } } };

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_EX",
    intent:
      "自身の現在HPの2.5%を消費し、消費HP×100%分のシールドと、最大HP×3.5%分のシールドを自身に付与する。加えて自身に対し4行動の間「アイデア」を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_EX" },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_EX_SHIELD_CONSUMED",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_EX_SHIELD_MAXHP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_EX_IDEA_MARK",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_EX_HP_COST",
          targets: ["ally:subject"],
        },
      ],
      // 消費前の現在HP5000の2.5%分(125)と、最大HP10000の3.5%分(350)の2枚のシールド。
      // HP消費は消費前の現在HPの2.5%(125)を最後に引く。
      hpDeltas: { "ally:subject": -125 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_EX_SHIELD_CONSUMED",
          magnitude: 125,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_EX_SHIELD_MAXHP",
          magnitude: 350,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: IDEA, stackCount: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_EX",
    intent: "(不成立): 自身が「創作」状態の場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_EX" },
    board: { subject: { markers: [{ markerId: CREATION }] } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_AS1",
    intent:
      "「創作」状態ではない場合、敵単体に威力93.6で攻撃する。加えて総ダメージの50%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_AS1_LIFESTEAL",
          targets: ["ally:subject"],
        },
      ],
      // (1000-500)×0.936=468。回復は総ダメージ468の50%=234。
      hpDeltas: { "enemy:front": -468, "ally:subject": 234 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_AS1",
    intent: "「アイデア」を所持している場合、さらに威力46.8で追加攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_AS1" },
    board: { subject: { markers: [{ markerId: IDEA }] } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_AS1_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_AS1_DAMAGE_IDEA",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_AS1_LIFESTEAL",
          targets: ["ally:subject"],
        },
      ],
      // 468 + (1000-500)×0.468=234 = 702。回復は総ダメージ702の50%=351。
      hpDeltas: { "enemy:front": -702, "ally:subject": 351 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_AS1",
    intent: "「創作」状態の場合、自身のHPを最大HPの1.5%回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_AS1" },
    board: { subject: { markers: [{ markerId: CREATION }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_AS1_CREATION_HEAL",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: { "ally:subject": 150 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS1",
    intent:
      "累計で最大HP×0.75%のダメージを受けるたびに発動。HP割合が低い順に味方2体のHPを威力35で回復し、自身のPPを1回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS1",
      // (1000-500)×0.2=100。最大HP10000の0.75%(75)を上回る一撃で閾値を跨ぐ。
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS", power: 0.2 }),
    },
    board: {
      allies: [
        { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
        {
          id: "ally:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 1000 },
        },
      ],
    },
    expected: {
      // HP割合: ally:back 10% < ally:subject(被弾後 4900/10000=49%) < ally:front 50%。
      // 低い順の2体はally:back・ally:subject。
      actions: [
        { effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS1_HEAL", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS1_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS1_PP_UP", targets: ["ally:subject"] },
      ],
      // HEALのSKILL_POWERは施術者の攻撃力1000×0.35=350。被弾ダメージ自体は基準線に含まれる。
      hpDeltas: { "ally:back": 350, "ally:subject": 350 },
      // PP: コスト-1とPS1_PP_UPの+1が相殺して差分0（観測から落ちる）。EXゲージのみ+1。
      resources: [{ unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 }],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS1",
    intent: "(不成立): 累計被ダメージが最大HP×0.75%に届かない被弾では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS1",
      // (1000-500)×0.1=50 < 75。
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS", power: 0.1 }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS1",
    intent: "(不成立): 自身が「創作」状態の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS1",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS", power: 0.2 }),
    },
    board: { subject: { markers: [{ markerId: CREATION }] } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
    intent:
      "自身のHPが20%未満の状態で敵から攻撃される直前に発動。自身に対し、一度だけ致死ダメージを耐え、HPを最大HP×1.5%回復するバフを付与する。さらに自身の攻撃力を6%、防御力を6%上昇させ(重複可)、自身に対し2行動の間「創作」を付与する(解除不可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    board: LOW_HP,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS2_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS2_ATK_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS2_DEF_UP",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS2_CREATION_MARK",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS2_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS2_ATK_UP",
          magnitude: 0.06,
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS2_DEF_UP",
          magnitude: 0.06,
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: CREATION, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
    intent: "(不成立): 自身のHPが20%以上残っていれば発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
    intent: "(不成立): 自身が「創作」状態の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    board: { subject: { state: { currentHp: 1000 }, markers: [{ markerId: CREATION }] } },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
    intent: "(不成立): 生存している味方が自身のみの場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS2",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    board: { subject: { state: { currentHp: 1000 } }, allies: [] },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS3",
    intent:
      "自身が敵から攻撃される直前に発動。自身に対しこの行動内で受けるダメージを75%減少させる効果を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS3",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    board: { subject: { markers: [{ markerId: CREATION }] } },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS3_DMG_DOWN",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_ROSIE_CAMPAIGN_TEX_PS3_DMG_DOWN",
          magnitude: -0.75,
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
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS3",
    intent: "(不成立): 自身が「創作」状態ではない場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS3",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS3",
    intent: "(不成立): 生存している味方が自身のみの場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_ROSIE_CAMPAIGN_TEX_PS3",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:subject" }),
    },
    board: { subject: { markers: [{ markerId: CREATION }] }, allies: [] },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_ROSIE_CAMPAIGN_TEX (破壊：ロージー・ヒューズ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-ROSIE-CAMPAIGN-TEX-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-ROSIE-CAMPAIGN-TEX-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-ROSIE-CAMPAIGN-TEX-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
