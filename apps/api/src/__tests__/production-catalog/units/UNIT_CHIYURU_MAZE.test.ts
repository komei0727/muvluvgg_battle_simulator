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
  skillUseCompleted,
  skillUseStarting,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_CHIYURU_MAZE`（【博識なメイズの探求者】月ヶ瀬ちゆる）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_CHIYURU_MAZE";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/** 契機を出す味方の属性・タイプを差し替えた味方配置（PSの発動条件の作り分け）。 */
function alliesWith(overrides: Partial<BoardUnitSpec>): readonly BoardUnitSpec[] {
  return [
    { id: "ally:front", position: { column: "LEFT", row: "FRONT" }, ...overrides },
    { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
  ];
}

/**
 * 敵前列だけHPを高くした配置（`HP_RATIO >= 0.8`の成立側を作る）。攻撃後にちょうど
 * 9000へ落ちる値にして、現在HP割合で決まる毒の効果量を丸めのない900にする。
 */
const HIGH_HP_FRONT: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 9702 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_EX",
    intent: "敵全体に威力117で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
        "enemy:back": -585,
      },
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_EX",
    intent:
      "対象が状態異常にある場合、1行動分の気絶を付与し、一度だけ対象の受ける被ダメージを100%増加させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_EX" },
    // 状態異常は実 production の毒定義で作る（AOE内の1体だけが条件を満たす局面）。
    precedingActions: [
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", target: "ENEMY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_STUN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
        "enemy:back": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_EX_DAMAGE_TAKEN_UP",
          magnitude: 1,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS1",
    intent: "敵前後列に威力140.56で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1" },
    expected: {
      // 基準敵は既定順の敵前列で、その前後列＝CENTER列。
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -702,
        "enemy:back": -702,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS1",
    intent: "対象が毒状態だった場合一時的に防御力を20%低下させ（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1" },
    precedingActions: [
      { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", target: "ENEMY" },
    ],
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DEF_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      // 防御力が500→400へ下がった基準敵だけ、同じ威力で被ダメージが増える。
      hpDeltas: {
        "enemy:front": -843,
        "enemy:back": -702,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DEF_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS1",
    intent:
      "対象のHPが80%以上だった場合、対象に3行動の間毒を付与する。毒状態は行動タイミングごとに現在HPの10%のダメージを受ける",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1" },
    board: { enemies: HIGH_HP_FRONT },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -702,
        "enemy:back": -702,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS1_POISON",
          // 攻撃後の現在HP9000の10%。
          magnitude: 900,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_AS2",
    intent: "敵単体に威力13.26で13ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_CHIYURU_MAZE_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_AS2_DAMAGE", targets: ["enemy:front"] },
      ],
      // 1ヒット66（500×13.26%の切り捨て）×13ヒット。
      hpDeltas: {
        "enemy:front": -858,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
    intent:
      "他のシャイ属性の味方がアクティブスキルで攻撃した後に発動。攻撃された対象に対して威力106で追撃し、2行動分の毒を付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ attribute: "SHY" }) },
    expected: {
      // 追撃は既定の対象選択ではなく「攻撃された対象」へ向かう。
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS1_POISON", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:left": -530,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS1_POISON",
          // 追撃後の現在HP4470の10%。
          magnitude: 447,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
    intent: "(不成立): シャイ属性でない味方のアクティブスキル攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS1",
      trigger: skillUseCompleted({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ attribute: "CUTE" }) },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
    intent:
      "(同時発動制限)他の敏捷タイプの味方がアクティブスキルで攻撃する前に発動。当該攻撃に威力38.16のダメージと、3行動分の毒効果を追加する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ unitType: "AGILE" }) },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS2_DAMAGE_ADD", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS2_POISON", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:left": -190,
      },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_CHIYURU_MAZE_PS2_POISON",
          // 追加ダメージ後の現在HP4810の10%。
          magnitude: 481,
          timeLimit: { unit: "ACTION", count: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_CHIYURU_MAZE_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
    intent: "(不成立): 敏捷タイプでない味方のアクティブスキル攻撃では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_CHIYURU_MAZE_PS2",
      trigger: skillUseStarting({
        actor: "ally:front",
        targets: ["enemy:left"],
        skillType: "AS",
      }),
      triggeredBy: "ally:front",
    },
    board: { allies: alliesWith({ unitType: "ENERGY" }) },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_CHIYURU_MAZE (【博識なメイズの探求者】月ヶ瀬ちゆる)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-CHIYURU-MAZE-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-CHIYURU-MAZE-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-CHIYURU-MAZE-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
