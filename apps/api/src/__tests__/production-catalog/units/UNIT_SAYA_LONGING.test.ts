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
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  skillUseStarting,
  turnCompleting,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SAYA_LONGING`（【渇望秘めし淑女】紫雲沙耶）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SAYA_LONGING";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** AS1の分岐が読む `UNIT_TYPE` を作り分ける盤面。 */
const ENERGY_TYPE_ENEMY: BoardOverrides = {
  enemies: [
    { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, unitType: "ENERGY" },
    { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
    { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SAYA_LONGING_EX",
    intent:
      "敵全体に威力120.48でEN攻撃し、与えたダメージの25%分自身のHPを回復する。さらに3行動分の炎上を付与する。炎上は攻撃力×30%の持続ダメージを与える",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_LONGING_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SAYA_LONGING_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_EX_BURN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_EX_BURN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_EX_BURN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_EX_HEAL", targets: ["ally:subject"] },
      ],
      // 3体へ602ずつ、その合計1806の25%を回復する（最後の1体分ではない）。
      hpDeltas: {
        "ally:subject": 451,
        "enemy:front": -602,
        "enemy:left": -602,
        "enemy:back": -602,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SAYA_LONGING_EX_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_SAYA_LONGING_EX_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_SAYA_LONGING_EX_BURN",
          magnitude: 300,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_AS1",
    intent: "敵単体に威力189.6でEN攻撃し、与えたダメージの50%分自身のHPを回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_LONGING_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_AS1_HEAL", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 711,
        "enemy:front": -1422,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SAYA_LONGING_PS2", remaining: 1 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_SAYA_LONGING_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_AS1",
    intent: "対象がENタイプの場合、さらに対象のPPを1削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_LONGING_AS1" },
    board: ENERGY_TYPE_ENEMY,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_AS1_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_AS1_PP_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "ally:subject": 711,
        "enemy:front": -1422,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -2 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
        { unitId: "enemy:front", resource: "PP", delta: -1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SAYA_LONGING_PS2", remaining: 1 },
        { unitId: "ally:subject", skillDefinitionId: "SKL_SAYA_LONGING_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_AS2",
    intent: "敵単体に威力62.4でEN攻撃する。自身のHPが多いほどダメージが増加する（+300%まで）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_LONGING_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -1170,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SAYA_LONGING_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_AS2",
    intent: "(境界): 自身が満タンなら増加率は上限の+300%になる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SAYA_LONGING_AS2" },
    board: { subject: { state: { currentHp: 10000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -2496,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SAYA_LONGING_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_PS1",
    intent:
      "ターン終了時に発動。自身に対し、次の攻撃で与えるダメージを50%上昇させるバフを付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SAYA_LONGING_PS1",
      trigger: turnCompleting({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS1_DMG_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SAYA_LONGING_PS1_DMG_UP",
          magnitude: 0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_PS1",
    intent: "(不成立): このスキルは1ターン目には発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SAYA_LONGING_PS1",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_PS2",
    intent:
      "自身がアクティブスキルで攻撃する前に発動。一度だけ自身の攻撃力を最高50%、会心率を最高40%上昇させる。自身のHPが多いほど高い効果を発揮する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SAYA_LONGING_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_CRIT_UP", targets: ["ally:subject"] },
      ],
      // HP割合50%なので上限の半分（攻撃力+25%・会心率+20%）。
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_ATK_UP",
          magnitude: 0.25,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SAYA_LONGING_PS2_CRIT_UP",
          magnitude: 0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SAYA_LONGING_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SAYA_LONGING_PS2",
    intent: "(不成立): EXスキルの使用開始では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SAYA_LONGING_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_SAYA_LONGING (【渇望秘めし淑女】紫雲沙耶)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SAYA-LONGING-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SAYA-LONGING-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SAYA-LONGING-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
