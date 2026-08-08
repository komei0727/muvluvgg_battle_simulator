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
import { skillUseStarting } from "../../../testing/production-unit/trigger-events.js";
import { SequenceRandomSource } from "../../../testing/random/sequence-random-source.js";

/**
 * `UNIT_RAMI_NEWYEAR`(【大吉ハッピーニューイヤー】朽葉ラミ)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_RAMI_NEWYEAR";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** PS1は自身のHPが50%以下では発動しない。既定盤面はちょうど50%のため引き上げる。 */
const PS1_READY = { subject: { state: { currentHp: 8000 } } };

/**
 * おみくじの `RANDOM_BRANCH: WEIGHTED_ONE` を狙った腕へ倒す抽選列。累積weightは
 * 大吉10・中吉30・小吉60・末吉100で、`roll = next() * 100` がこの区間に入る腕が
 * 選ばれる（`random-branch-selection.ts`、R-SKL-07「乱数消費順はCatalog定義順」）。
 */
function omikuji(roll: number): () => SequenceRandomSource {
  return () => new SequenceRandomSource(new Array<number>(64).fill(roll));
}

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_EX",
    intent:
      "最も近い位置にいる敵単体、および対象に隣接する敵に対して威力117で攻撃し、1行動の凍結を付与する。凍結中は全ての行動を行うことが出来ない。ダメージを受けると凍結状態は解除されるが、その際の被ダメージが100%増加する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_NEWYEAR_EX" },
    expected: {
      // 自身は敵前列中央の正面に居るため最も近い敵は enemy:front。その直交隣接は
      // 同じ前列の enemy:left と真後ろの enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_FREEZE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_FREEZE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_FREEZE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -585, "enemy:left": -585, "enemy:back": -585 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "FREEZE",
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "FREEZE",
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_EX_FREEZE",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "FREEZE",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_AS1",
    intent: "敵前後列に威力137.8で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_NEWYEAR_AS1" },
    expected: {
      // 「前後列」は既定対象（敵前列中央）と同じ縦列の enemy:front・enemy:back。
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: { "enemy:front": -689, "enemy:back": -689 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_NEWYEAR_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_AS2",
    intent: "敵横一列に威力78で攻撃し、次の攻撃の与ダメージを20%減少させるデバフを付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_NEWYEAR_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS2_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS2_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS2_DMG_DOWN", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:front": -390, "enemy:left": -390 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS2_DMG_DOWN",
          magnitude: -0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS2_DMG_DOWN",
          magnitude: -0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_NEWYEAR_AS2", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_AS3",
    intent: "敵単体に威力169.6で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_NEWYEAR_AS3" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_AS3_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -848 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
    intent:
      "自身がアクティブスキルで攻撃する前に発動。大吉(抽選確率10%): 相手の防御力を50%無視する。加えて、どの結果であっても与ダメージを20%増加させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_RAMI_NEWYEAR_AS3",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_READY,
    random: omikuji(0),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_PIERCE_DAIKICHI",
          // 防御無視率は`APPLY_PIERCING_MOD`のpayloadが持ち、効果量としては持たない。
          // 大吉と中吉を分けているのは実行されたEffectAction IDそのものである。
          magnitude: 0,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
    intent: "中吉(抽選確率20%): 相手の防御力を25%無視する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_RAMI_NEWYEAR_AS3",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_READY,
    random: omikuji(0.2),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_PIERCE_CHUKICHI",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_PIERCE_CHUKICHI",
          // 防御無視率は`APPLY_PIERCING_MOD`のpayloadが持ち、効果量としては持たない。
          // 大吉と中吉を分けているのは実行されたEffectAction IDそのものである。
          magnitude: 0,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
    intent: "小吉(抽選確率30%): 自身の攻撃力を10%上昇させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_RAMI_NEWYEAR_AS3",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_READY,
    random: omikuji(0.5),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_ATK_UP_10", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_ATK_UP_10",
          magnitude: 0.1,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
    intent: "末吉(抽選確率40%): 自身の攻撃力を5%上昇させる(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_RAMI_NEWYEAR_AS3",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_READY,
    random: omikuji(0.99),
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_ATK_UP_5", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_DMG_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_NEWYEAR_PS1_ATK_UP_5",
          magnitude: 0.05,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
    intent: "(不成立): 自身のHPが50%以下の場合、このスキルは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_RAMI_NEWYEAR_AS3",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
    intent: "(不成立): EXスキルの使用前では発動しない(「アクティブスキルで攻撃する前」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_NEWYEAR_PS1",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_RAMI_NEWYEAR_EX",
      }),
      triggeredBy: "ally:subject",
    },
    board: PS1_READY,
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_RAMI_NEWYEAR (【大吉ハッピーニューイヤー】朽葉ラミ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-RAMI-NEWYEAR-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-RAMI-NEWYEAR-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-RAMI-NEWYEAR-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
