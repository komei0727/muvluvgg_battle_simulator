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
import { turnCompleting, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LILY_HERO`（【正義のヒーロー】リリー・ラヴォア）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LILY_HERO";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LILY_HERO_EX",
    intent:
      "敵単体に威力312で攻撃し、自身の失ったHP30%を回復する。さらに1行動の間、自身の行動速度を150上昇させる。また、自身の与ダメージを50%上昇させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_SPEED_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_EX_DAMAGE_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 1500,
        "enemy:front": -1560,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_HERO_EX_SPEED_UP",
          magnitude: 150,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_HERO_EX_DAMAGE_UP",
          magnitude: 0.5,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_AS1",
    intent:
      "自身の最大HP10%を消費し、自身に最も近い位置にいる敵単体および対象に隣接する敵に対し消費HP×319.8%のダメージを与える攻撃、および威力78の攻撃を行う",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_HP_COST", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_HPCOST", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_FIXED", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_HPCOST", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_FIXED", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_HPCOST", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS1_DAMAGE_FIXED", targets: ["enemy:back"] },
      ],
      // 消費HP分の一撃（最大HP10000 × 31.98% を切り捨てた3197）と、威力78の一撃390。
      hpDeltas: {
        "ally:subject": -1000,
        "enemy:front": -3587,
        "enemy:left": -3587,
        "enemy:back": -3587,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_AS1",
    intent: "(不成立): 自身のHPが20%未満の場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS1" },
    board: { subject: { state: { currentHp: 1500 } } },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_AS2",
    intent: "敵単体に威力156で攻撃し、1行動の間対象の行動速度を90低下させ、1行動の気絶を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LILY_HERO_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LILY_HERO_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS2_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LILY_HERO_AS2_STUN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -780,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LILY_HERO_AS2_SPEED_DOWN",
          magnitude: -90,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LILY_HERO_AS2_STUN",
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
    skillDefinitionId: "SKL_LILY_HERO_PS1",
    intent:
      "自身が敵を倒した際に発動。2行動の間、自身が受ける攻撃のダメージを50%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_HERO_PS1",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LILY_HERO_PS1_DAMAGE_REDUCTION",
          targets: ["ally:subject"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LILY_HERO_PS1_DAMAGE_REDUCTION",
          magnitude: -0.5,
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
    skillDefinitionId: "SKL_LILY_HERO_PS1",
    intent: "(不成立): 味方が倒れても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_HERO_PS1",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LILY_HERO_PS2",
    intent: "ターン終了時に発動。自身の失ったHPの50%を回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LILY_HERO_PS2",
      trigger: turnCompleting({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [{ effectActionDefinitionId: "ACT_LILY_HERO_PS2_HEAL", targets: ["ally:subject"] }],
      hpDeltas: {
        "ally:subject": 2500,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_LILY_HERO (【正義のヒーロー】リリー・ラヴォア)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LILY-HERO-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LILY-HERO-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LILY-HERO-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
