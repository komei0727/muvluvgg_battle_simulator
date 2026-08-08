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
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_NOEL_RUMBLE`(【体育祭の暴れん坊】ノエル・アルエ)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_NOEL_RUMBLE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 最も近い敵だけがEX1撃目で落ちる残HP。生存分岐の不成立側を作る。 */
const NEAREST_ENEMY_ALMOST_DEAD: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 100 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_EX",
    intent:
      "最も近い位置にいる敵単体、および対象に隣接する敵に対し、威力275.6で攻撃する。攻撃後に最も近い位置にいる敵単体が生存していた場合、さらに敵単体に対して威力39でもう一度攻撃し、3行動分の炎上を付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_EX" },
    expected: {
      // 自身は敵前列中央の正面に居るため最も近い敵は enemy:front。その直交隣接は
      // 同じ前列の enemy:left と真後ろの enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE2", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_BURN", targets: ["enemy:front"] },
      ],
      // 1撃目1378（威力275.6%）、最も近い敵にはさらに2撃目195（威力39%）。
      hpDeltas: { "enemy:front": -1573, "enemy:left": -1378, "enemy:back": -1378 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_EX",
    intent: "(不成立): 最も近い敵が1撃目で戦闘不能になった場合、2撃目と炎上は入らない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_EX" },
    board: { enemies: NEAREST_ENEMY_ALMOST_DEAD },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_DAMAGE1", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -100, "enemy:left": -1378, "enemy:back": -1378 },
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_AS1",
    intent: "敵単体に威力162.24で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1" },
    expected: {
      // PS1（「自身がアクティブスキルで攻撃した直後に発動」）が使用完了の契機で走る。
      // 攻撃力上昇はこの攻撃の後に入るため、ダメージ自体は素の811のまま。
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -811 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_AS1",
    intent: "対象が炎上状態だった場合、この攻撃ダメージは50%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1" },
    // 炎上は実 production 定義（EXが配る炎上）で用意する。
    precedingActions: [{ effectActionDefinitionId: "ACT_NOEL_RUMBLE_EX_BURN", target: "ENEMY" }],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_AS1_DAMAGE_VS_BURNING",
          targets: ["enemy:front"],
        },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 811（威力162.24%）の50%増しを、別定義の威力243.36%として持つ。
      hpDeltas: { "enemy:front": -1216 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_NOEL_RUMBLE_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_AS2",
    intent: "敵単体に威力212で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_NOEL_RUMBLE_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      hpDeltas: { "enemy:front": -1060 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
    intent:
      "自身がアクティブスキルで攻撃した直後に発動。自身の攻撃力を18%上昇させ(重複可)、被ダメージを15%減少させる効果を付与する(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_NOEL_RUMBLE_AS2",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_DMG_DOWN",
          magnitude: -0.15,
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
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
    intent: "(不成立): EXスキルの使用では発動しない(「アクティブスキルで」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_NOEL_RUMBLE_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
    intent:
      "ターン開始時に発動。自身にかけられているバフをすべて解除し、自身のHPを威力50で回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    // 解除対象のバフを実 production 定義（PS1の攻撃力上昇）で用意する。
    precedingActions: [{ effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP", target: "SELF" }],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS2_REMOVE_BUFF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS2_HEAL", targets: ["ally:subject"] },
      ],
      hpDeltas: { "ally:subject": 500 },
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_NOEL_RUMBLE_PS1_ATK_UP",
          magnitude: 0.18,
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
    skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
    intent: "(不成立): このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_NOEL_RUMBLE_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_NOEL_RUMBLE (【体育祭の暴れん坊】ノエル・アルエ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-NOEL-RUMBLE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-NOEL-RUMBLE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-NOEL-RUMBLE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
