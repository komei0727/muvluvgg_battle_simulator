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

/**
 * `UNIT_MAIA_LAZY`（【温厚篤実な面倒くさがり】夕凪舞亜）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MAIA_LAZY";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 後列に味方を2体置き、「対象と同じ前後列の**他の**味方」が判別できるようにする。 */
const TWO_BACK_ALLIES: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
  { id: "ally:back2", position: { column: "RIGHT", row: "BACK" } },
];

/** 攻撃力が1体だけ高く、APにも空きがある味方。`HIGHEST_ATTACK` の判別用。 */
const ALLY_WITH_HIGHEST_ATTACK: readonly BoardUnitSpec[] = [
  {
    id: "ally:front",
    position: { column: "LEFT", row: "FRONT" },
    state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 }, currentAp: 2 },
  },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
];

/** 後列の敵1体だけの陣。前提アクションのバフ先とAS1の対象を同じ敵へ揃える。 */
const SINGLE_BACK_ENEMY: readonly BoardUnitSpec[] = [
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MAIA_LAZY_EX",
    intent:
      "前列の味方のHPを威力55で回復し、1行動の間攻撃力を10%上昇させる(重複可)。さらに敵横一列に対して威力94.8でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_LAZY_EX" },
    expected: {
      // 前列の味方は自身と ally:front。敵横一列は既定対象（敵前列中央）と同じ行の
      // enemy:front・enemy:left。
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_LAZY_EX_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_EX_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_EX_HEAL", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_EX_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_EX_DAMAGE", targets: ["enemy:left"] },
      ],
      // 対象ごとに回復→バフの順で解決するため、自身への攻撃力バフ（+10%）が
      // ally:front の回復量（605）と、その後の攻撃（攻撃力1100 - 防御500 に
      // 威力94.8%で568、切り捨て）に乗る。
      hpDeltas: {
        "ally:subject": 550,
        "ally:front": 605,
        "enemy:front": -568,
        "enemy:left": -568,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MAIA_LAZY_EX_ATK_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MAIA_LAZY_EX_ATK_UP",
          magnitude: 0.1,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_LAZY_AS1",
    intent: "後列優先で、敵単体に威力156でEN攻撃する（対象がバフ状態にない場合）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_LAZY_AS1" },
    expected: {
      actions: [{ effectActionDefinitionId: "ACT_MAIA_LAZY_AS1_DAMAGE", targets: ["enemy:back"] }],
      hpDeltas: { "enemy:back": -780 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_MAIA_LAZY_AS1", remaining: 3 }],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_LAZY_AS1",
    intent:
      "対象がバフ状態にあった場合、自身を除く味方全体に攻撃力×50%のシールドを付与する。シールドは攻撃を1ヒット受けたら消滅する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_LAZY_AS1" },
    board: { enemies: SINGLE_BACK_ENEMY },
    // バフ状態は実 production 定義（EXの攻撃力上昇）で作る。
    precedingActions: [{ effectActionDefinitionId: "ACT_MAIA_LAZY_EX_ATK_UP", target: "ENEMY" }],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_LAZY_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_AS1_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_AS1_SHIELD", targets: ["ally:back"] },
      ],
      hpDeltas: { "enemy:back": -780 },
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MAIA_LAZY_AS1_SHIELD",
          magnitude: 500,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MAIA_LAZY_AS1_SHIELD",
          magnitude: 500,
          consumption: { kind: "INCOMING_HIT", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_MAIA_LAZY_AS1", remaining: 3 }],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_LAZY_AS2",
    intent:
      "最もHP割合の低い味方に対して威力55で回復する。さらに対象と同じ前後列の他の味方に対し、2行動の間、行動時に最大HP×10%分のHPが回復する効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_LAZY_AS2" },
    board: { allies: TWO_BACK_ALLIES },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_LAZY_AS2_HEAL", targets: ["ally:back"] },
        {
          effectActionDefinitionId: "ACT_MAIA_LAZY_AS2_HEAL_OVER_TIME",
          targets: ["ally:back2"],
        },
      ],
      hpDeltas: { "ally:back": 550 },
      effectsApplied: [
        {
          unitId: "ally:back2",
          effectActionDefinitionId: "ACT_MAIA_LAZY_AS2_HEAL_OVER_TIME",
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_MAIA_LAZY_AS2", remaining: 3 }],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_LAZY_AS3",
    intent: "攻撃力が最も高い味方の攻撃力を1行動の間60%上昇させ(重複可)、APを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_LAZY_AS3" },
    board: { allies: ALLY_WITH_HIGHEST_ATTACK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MAIA_LAZY_AS3_ATK_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MAIA_LAZY_AS3_AP_UP", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MAIA_LAZY_AS3_ATK_UP",
          magnitude: 0.6,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "ally:front", resource: "AP", delta: 1 },
      ],
      cooldowns: [{ unitId: "ally:subject", skillDefinitionId: "SKL_MAIA_LAZY_AS3", remaining: 3 }],
    },
  },
  {
    skillDefinitionId: "SKL_MAIA_LAZY_AS4",
    intent: "敵単体に威力212でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MAIA_LAZY_AS4" },
    expected: {
      actions: [{ effectActionDefinitionId: "ACT_MAIA_LAZY_AS4_DAMAGE", targets: ["enemy:front"] }],
      hpDeltas: { "enemy:front": -1060 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_MAIA_LAZY (【温厚篤実な面倒くさがり】夕凪舞亜)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MAIA-LAZY-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MAIA-LAZY-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MAIA-LAZY-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
