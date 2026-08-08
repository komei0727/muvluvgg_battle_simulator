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
import { realDamage } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_FLUTE_INFLUENCER`（【ギャルインフルエンサー】フルート・メルヴィル）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_FLUTE_INFLUENCER";

/**
 * PS2の「デバフがかけられていた場合」の腕は、前提としてデバフの実在を要求する。
 * フルート自身はデバフを配らないため、前提を手組みの`AppliedEffect`ではなく実
 * production定義で作れるよう、デバフ源となる別ユニットの定義だけを併せて読み込む
 * （`ACT_CLARA_TSUNDERE_AS2_ATK_DOWN`）。検証対象はあくまでフルートの定義で、
 * `-002`／`-003` はこのユニットのSkill・EffectAction閉包だけを見る。
 */
const DEBUFF_SOURCE_UNIT_ID = "UNIT_CLARA_TSUNDERE";
const DEBUFF_ACTION_ID = "ACT_CLARA_TSUNDERE_AS2_ATK_DOWN";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  DEBUFF_SOURCE_UNIT_ID,
]);

/** HP割合が最も低い味方を一意にする盤面（`LOWEST_HP_RATIO` の解決先を固定する）。 */
const DISTINCT_LOWEST_ALLY: BoardOverrides = {
  allies: [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 2000 } },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_EX",
    intent:
      "味方全体のHPを最大HPの45%分回復する。さらに最もHP割合の低い味方に対して、威力97.5で追加回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_INFLUENCER_EX" },
    board: DISTINCT_LOWEST_ALLY,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_EX_HEAL_ALL",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_EX_HEAL_ALL", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_EX_HEAL_ALL", targets: ["ally:back"] },
        {
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_EX_HEAL_LOWEST",
          targets: ["ally:front"],
        },
      ],
      hpDeltas: {
        "ally:subject": 4500,
        "ally:front": 5475,
        "ally:back": 4500,
      },
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_AS1",
    intent:
      "最もHP割合の低い味方が含まれる一列に対し、5行動の間、行動時に最大HPの15%のHPを回復する効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_INFLUENCER_AS1" },
    board: DISTINCT_LOWEST_ALLY,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_AS1_HEAL_OVER_TIME",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_AS1_HEAL_OVER_TIME",
          targets: ["ally:front"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_AS1_HEAL_OVER_TIME",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 5 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_AS1_HEAL_OVER_TIME",
          magnitude: 1500,
          timeLimit: { unit: "ACTION", count: 5 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_FLUTE_INFLUENCER_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_AS2",
    intent: "敵単体に威力124.8でEN攻撃する。さらに対象に隣接する敵に対し、威力62.4でEN攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_FLUTE_INFLUENCER_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_AS2_DAMAGE", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_AS2_DAMAGE_ADJACENT",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_AS2_DAMAGE_ADJACENT",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -624,
        "enemy:left": -312,
        "enemy:back": -312,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS1",
    intent:
      "味方が攻撃され、HPが50%以下になった際に発動。味方単体に対し、攻撃力×150%までのENダメージを防ぐシールドを付与する。シールドは攻撃を1ヒット受けたら消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:front",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_PS1_SHIELD", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_PS1_SHIELD",
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
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS1",
    intent: "(不成立): HPが50%より多く残っている味方では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:front",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: {
      allies: [
        {
          id: "ally:front",
          position: { column: "LEFT", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2",
    intent: "味方が攻撃を受けた直後に発動。攻撃を受けた味方単体のHPを威力55で回復する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_PS2_HEAL", targets: ["ally:front"] },
      ],
      hpDeltas: {
        "ally:front": 550,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2",
    intent: "対象の味方にデバフがかけられていた場合、回復量が100%増加し、デバフをすべて解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:subject", skillType: "AS" }),
    },
    precedingActions: [{ effectActionDefinitionId: DEBUFF_ACTION_ID, target: "SELF" }],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_PS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_PS2_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_FLUTE_INFLUENCER_PS2_REMOVE_DEBUFF",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 880,
      },
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: DEBUFF_ACTION_ID,
          magnitude: -0.2,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2",
    intent: "(不成立): 味方が与えたダメージでは発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_FLUTE_INFLUENCER_PS2",
      trigger: realDamage({ from: "ally:back", to: "ally:front", skillType: "AS" }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_FLUTE_INFLUENCER (【ギャルインフルエンサー】フルート・メルヴィル)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-FLUTE-INFLUENCER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-FLUTE-INFLUENCER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-FLUTE-INFLUENCER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
