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
import {
  criticalCheckResolved,
  realDamage,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_SENKA_CHRISTMAS`(【クリスマスコーデの参謀】姫川泉花)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_SENKA_CHRISTMAS";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 1撃ではHP50%を割り込まない敵。AS1の被ダメージ減少分岐の不成立側を作る。 */
const ENEMY_AT_FULL_HP: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 10000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** HP割合が1体だけ低い味方陣。AS2の `LOWEST_HP_RATIO` と回復量の増加の判別用。 */
const ALLY_WITH_LOWEST_HP: readonly BoardUnitSpec[] = [
  { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
  { id: "ally:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_EX",
    intent:
      "味方全体に攻撃力55%のシールドを付与する。シールドはスキル使用者の1行動後に消滅する。さらに味方全体に対し2行動の間、行動時に威力15でHPを回復する効果を付与する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_CHRISTMAS_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_HEAL", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_SHIELD", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_HEAL", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          // 攻撃力1000の55%。期間は使用者（`EFFECT_SOURCE`）の1行動。
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_SHIELD",
          magnitude: 550,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_HEAL",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_SHIELD",
          magnitude: 550,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_HEAL",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_SHIELD",
          magnitude: 550,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_EX_HEAL",
          magnitude: 0.15,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS1",
    intent:
      "敵単体に威力140.4で攻撃する。この攻撃によって対象のHPが50%を下回った場合、自身に対し、次に受ける攻撃の被ダメージを20%減少させる効果を付与する(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS1" },
    expected: {
      // PS2のtriggerは`CriticalCheckResolved`に`condition: TRUE`を置いており、会心が
      // 出たかどうかに関わらず攻撃のたびに発動する。この盤面では会心率0で対象にバフも
      // 無いため、解除は`SKIPPED`のまま発動コストだけが観測に残る。
      actions: [
        {
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS2_REMOVE_BUFF",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      // 5000から702減って4298（42.98%）となり、この攻撃で50%を下回る。
      hpDeltas: { "enemy:front": -702 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS1_DMG_DOWN",
          magnitude: -0.2,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS1",
    intent: "(不成立): 対象のHPが50%を下回らなかった場合、被ダメージ減少は付与されない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS1" },
    board: { enemies: ENEMY_AT_FULL_HP },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS2_REMOVE_BUFF",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -702 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS2",
    intent:
      "最もHP割合の低い味方単体のHPを威力35で回復する。対象のHPが少ないほど回復量が増加する(50%まで)。さらにスキル使用者が1回行動を終えるまでの間、対象の防御力を35%上昇させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_SENKA_CHRISTMAS_AS2" },
    board: { allies: ALLY_WITH_LOWEST_HP },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS2_HEAL", targets: ["ally:back"] },
        { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS2_DEF_UP", targets: ["ally:back"] },
      ],
      // 基礎350（攻撃力1000の35%）に、HP割合20%ぶんの増加（上限+50%の80%＝+40%）が
      // 乗って489（切り捨て）。
      hpDeltas: { "ally:back": 489 },
      effectsApplied: [
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS2_DEF_UP",
          magnitude: 0.35,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS1",
    intent:
      "自身が攻撃される直前に発動。敵の攻撃を50%ガードし、自身に向けられる状態異常を１つ無効にするバフを付与する。さらに自身の背後にいる味方単体に対し、次に受ける攻撃の被ダメージを25%減少させる効果を付与する(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "UnitBeingAttacked",
      }),
    },
    expected: {
      // 「自身の背後」は自身（CENTER FRONT）の真後ろに居る ally:back（CENTER BACK）。
      actions: [
        {
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS1_DMG_DOWN_SELF",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS1_STATUS_IMMUNITY",
          targets: ["ally:subject"],
        },
        {
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS1_ALLY_DMG_DOWN",
          targets: ["ally:back"],
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS1_DMG_DOWN_SELF",
          magnitude: -0.5,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS1_STATUS_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "STATUS_BLOCKED", maxCount: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS1_ALLY_DMG_DOWN",
          magnitude: -0.25,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS1",
    intent: "(不成立): 他の味方が攻撃される直前では発動しない(「自身が」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:front",
        skillType: "AS",
        event: "UnitBeingAttacked",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS2",
    intent:
      "自身の攻撃が会心攻撃になるたびに発動。自身が攻撃した対象にかけられているバフを全て解除する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS2",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "enemy:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    // 解除対象のバフを実 production 定義（AS2の防御力上昇）で用意する。
    precedingActions: [
      { effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS2_DEF_UP", target: "ENEMY" },
    ],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_PS2_REMOVE_BUFF",
          targets: ["enemy:front"],
        },
      ],
      effectsRemoved: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_SENKA_CHRISTMAS_AS2_DEF_UP",
          magnitude: 0.35,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS2",
    intent: "(不成立): 味方への会心判定では発動しない(「自身が攻撃した対象」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_SENKA_CHRISTMAS_PS2",
      trigger: criticalCheckResolved({
        source: "ally:subject",
        target: "ally:front",
        result: true,
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
];

describe("production Catalog UNIT_SENKA_CHRISTMAS (【クリスマスコーデの参謀】姫川泉花)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-SENKA-CHRISTMAS-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-SENKA-CHRISTMAS-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-SENKA-CHRISTMAS-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
