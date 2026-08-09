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
import { effectApplied, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LILY_SINGER`（【想い響かせるヒーローシンガー】リリー・ラヴォア）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LILY_SINGER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LILY_SINGER_EX",
    intent:
      "敵全体に対し、自身の現在HP×75%のダメージを与えるEN攻撃を行う。与えられるダメージは自身の攻撃力×75%を上限とする。さらに自身に対し1行動の間、敵から受ける攻撃のダメージを無効にする効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY", targets: ["ally:subject"] },
      ],
      // 現在HP5000の75%＝3750より、攻撃力1000の75%＝750の方が小さいので上限が効く
      // （`SKILL_POWER`ではないため防御力は引かれない、R-DMG-01）。
      hpDeltas: {
        "enemy:front": -750,
        "enemy:left": -750,
        "enemy:back": -750,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_EX",
    intent: "（現在HPが低い場合）上限ではなく自身の現在HP×75%がダメージになる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_EX" },
    board: { subject: { state: { currentHp: 400 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -300,
        "enemy:left": -300,
        "enemy:back": -300,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_EX_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_AS1",
    intent:
      "前列優先で味方単体に対し、攻撃を2回受けるまで被ダメージを無効にする効果を付与するが、同時に自身の行動速度を100低下させ（重複可）、さらに1行動の間自身の攻撃力を30%低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_AS1" },
    // 自身を後列に置き、「前列優先」が自身ではなく前列の味方を選ぶことを見る。
    board: { subject: { position: { column: "CENTER", row: "BACK" } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_IMMUNITY", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_SPEED_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_SPEED_DOWN",
          magnitude: -100,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "INCOMING_HIT", maxCount: 2 },
          statusKind: "DAMAGE_IMMUNITY",
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LILY_SINGER_AS1", remaining: 3 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_AS2",
    intent: "敵全体に威力63.6でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_SINGER_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_AS2_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -318,
        "enemy:left": -318,
        "enemy:back": -318,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS1",
    intent:
      "他の味方がデバフを付与された際に発動。対象の味方単体にかけられたデバフを5個解除し、次に受けるEN攻撃でのダメージを25%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:front",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      triggeredBy: "enemy:front",
    },
    // 解除対象を実 production 定義で用意する（前提アクションの適用は観測の基準線）。
    precedingActions: [
      { effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN", target: "ALLY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS1_REMOVE_DEBUFF", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS1_EN_DAMAGE_DOWN", targets: ["ally:front"] },
      ],
      effectsRemoved: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_AS1_ATK_DOWN",
          magnitude: -0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS1_EN_DAMAGE_DOWN",
          magnitude: -0.25,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LILY_SINGER_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS1",
    intent: "(不成立): 自身へのデバフ付与では発動しない（「他の味方が」付与された場合に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["DEBUFF"],
      }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS1",
    intent: "(不成立): 味方へのバフ付与では発動しない（「デバフを付与された際」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS1",
      trigger: effectApplied({
        source: "ally:back",
        target: "ally:front",
        effectKind: "APPLY_STAT_MOD",
        categories: ["BUFF"],
      }),
      triggeredBy: "ally:back",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_LILY_SINGER_PS2",
    intent:
      "ターン開始時に発動。前列の味方に自身の最大HP×25%のENシールドを付与する。さらに前列の味方の攻撃力を15%上昇させる（重複可）（解除不可）が、自身が次に受けるEN攻撃の被ダメージが10%増加するデバフも付与される（重複可）。シールドは2行動後に消滅し、シールドの消滅と共に攻撃力バフも消滅する。このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_SINGER_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SELF_EN_VULN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          // シールド量は付与者（自身）の最大HP10000の25%。
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SELF_EN_VULN",
          magnitude: 0.1,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_SHIELD",
          magnitude: 2500,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_LILY_SINGER_PS2_ATK_UP",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LILY_SINGER_PS2", remaining: 99 },
      ],
    },
  },
];

describe("production Catalog UNIT_LILY_SINGER (【想い響かせるヒーローシンガー】リリー・ラヴォア)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LILY-SINGER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LILY-SINGER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LILY-SINGER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
