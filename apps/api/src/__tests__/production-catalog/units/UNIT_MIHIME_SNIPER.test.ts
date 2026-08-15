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
import { realDamage, turnCompleting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_MIHIME_SNIPER`（【稀代の狙撃手】珠瀬壬姫）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MIHIME_SNIPER";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** raw原文「自身にかけられたデバフを3つまで解除し」。`ACT_MIHIME_SNIPER_PS1_REMOVE_DEBUFF.maxRemovals`。 */
const MAX_REMOVALS = 3;

/** HP割合が1位・2位で分かれる敵陣。「最も低い敵」と「もう1体」を判別する。 */
const ENEMIES_BY_HP_RANK: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" }, state: { currentHp: 3000 } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" }, state: { currentHp: 2000 } },
];

/** HP割合が最も低い敵を前列中央に置き、隣接が2体（左隣・後ろ）になるようにする。 */
const LOWEST_HP_AT_CENTER_FRONT: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 2000 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_MIHIME_SNIPER_EX",
    intent:
      "敵全体に威力117で攻撃し、味方全体に対し1行動の間与ダメージを20%上昇させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIHIME_SNIPER_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DMG_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DMG_UP", targets: ["ally:back"] },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
        "enemy:back": -585,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DMG_UP",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DMG_UP",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_EX_DMG_UP",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIHIME_SNIPER_AS1",
    intent:
      "最もHP割合の低い敵単体に対し威力148.2で攻撃し、対象および自身の行動速度を35低下させる（重複可）。さらにもう1体に威力65で攻撃し、対象の行動速度を20低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIHIME_SNIPER_AS1" },
    board: { enemies: ENEMIES_BY_HP_RANK },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_DAMAGE1", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SPD_DOWN1", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SELF_SPD_DOWN",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_DAMAGE2", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SPD_DOWN2", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:back": -741, "enemy:left": -325 },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SELF_SPD_DOWN",
          magnitude: -35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SPD_DOWN2",
          magnitude: -20,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SPD_DOWN1",
          magnitude: -35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIHIME_SNIPER_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIHIME_SNIPER_AS2",
    intent:
      "最もHP割合の低い敵単体に威力117、および対象に隣接する敵2体に対し威力116.6で攻撃し、行動速度を20低下させる（重複可）。また、自身の行動速度を35低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIHIME_SNIPER_AS2" },
    board: { enemies: LOWEST_HP_AT_CENTER_FRONT },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_DAMAGE2", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_DAMAGE2", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN", targets: ["enemy:back"] },
        {
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SELF_SPD_DOWN",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -583,
        "enemy:back": -583,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SELF_SPD_DOWN",
          magnitude: -35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN",
          magnitude: -20,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN",
          magnitude: -20,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN",
          magnitude: -20,
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
    skillDefinitionId: "SKL_MIHIME_SNIPER_PS1",
    intent:
      "ターン終了時に発動。自身にかけられたデバフを3つまで解除し、1行動の間自身の会心率を30%上昇させる（重複可）。さらに自身に対し、戦闘終了まで被ダメージを5%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIHIME_SNIPER_PS1",
      trigger: turnCompleting({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    // 解除対象を実 production 定義（AS1の自己行動速度低下）で用意する。
    precedingActions: [
      { effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SELF_SPD_DOWN", target: "SELF" },
    ],
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS1_REMOVE_DEBUFF",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS1_CRIT_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS1_DMG_DOWN", targets: ["ally:subject"] },
      ],
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SELF_SPD_DOWN",
          magnitude: -35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS1_CRIT_UP",
          magnitude: 0.3,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS1_DMG_DOWN",
          magnitude: -0.05,
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
    skillDefinitionId: "SKL_MIHIME_SNIPER_PS2",
    intent:
      "後列の味方が攻撃された後に発動。攻撃をした敵単体に威力137.8で反撃し、1行動の間行動速度を100低下させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIHIME_SNIPER_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:back", skillType: "AS" }),
      triggeredBy: "enemy:front",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS2_SPD_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: { "enemy:front": -689 },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS2_SPD_DOWN",
          magnitude: -100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MIHIME_SNIPER_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MIHIME_SNIPER_PS2",
    intent: "(不成立): 前列の味方が攻撃されても発動しない（「後列の味方が」に限る）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MIHIME_SNIPER_PS2",
      trigger: realDamage({ from: "enemy:front", to: "ally:front", skillType: "AS" }),
      triggeredBy: "enemy:front",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_MIHIME_SNIPER_AS2",
    intent: "同上: 敵が1体だけで隣接対象がいなくても、その1体へは通常どおり発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MIHIME_SNIPER_AS2" },
    board: { enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }] },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_DAMAGE1",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN",
          targets: ["enemy:front"],
        },
        {
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SELF_SPD_DOWN",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "enemy:front": -585,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SELF_SPD_DOWN",
          magnitude: -35,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS2_SPD_DOWN",
          magnitude: -20,
          timeLimit: {
            unit: "ACTION",
            count: 1,
          },
        },
      ],
      resources: [
        {
          unitId: "ally:subject",
          resource: "AP",
          delta: -1,
        },
        {
          unitId: "ally:subject",
          resource: "EX_GAUGE",
          delta: 1,
        },
      ],
    },
  },
];

describe("production Catalog UNIT_MIHIME_SNIPER (【稀代の狙撃手】珠瀬壬姫)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MIHIME-SNIPER-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MIHIME-SNIPER-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MIHIME-SNIPER-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-MIHIME-SNIPER-004 (R-EFF-02): PS1の「デバフを3つまで解除」は `maxRemovals` で頭打ちになる — 4つ持っていても3つしか解除されず、4つ目は残る", () => {
    // `-001` のPS1行は解除対象を1つしか持たないため、上限そのものは現れない
    // （上限が無くても、上限が10でも同じ観測になる）。上限より1つ多い前提を
    // 実 production 定義で積んで、解除件数が3で止まることを固定する。
    const observation = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: {
        kind: "PASSIVE",
        skillDefinitionId: "SKL_MIHIME_SNIPER_PS1",
        trigger: turnCompleting({ turnNumber: 1 }),
        triggeredBy: "ally:subject",
      },
      precedingActions: Array.from({ length: MAX_REMOVALS + 1 }, () => ({
        effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SELF_SPD_DOWN",
        target: "SELF" as const,
      })),
    });

    expect(observation.effectsRemoved).toEqual(
      Array.from({ length: MAX_REMOVALS }, () => ({
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MIHIME_SNIPER_AS1_SELF_SPD_DOWN",
        magnitude: -35,
        timeLimit: { unit: "ACTION", count: 1 },
      })),
    );
    // 解除されなかった1件は行動速度へ効いたままになる（実効値まで戻らない）。
    expect(observation.effectsApplied).toEqual([
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS1_CRIT_UP",
        magnitude: 0.3,
        timeLimit: { unit: "ACTION", count: 1 },
      },
      {
        unitId: "ally:subject",
        effectActionDefinitionId: "ACT_MIHIME_SNIPER_PS1_DMG_DOWN",
        magnitude: -0.05,
        timeLimit: { unit: "BATTLE", count: 1 },
      },
    ]);
  });
});
