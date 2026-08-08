import { describe, expect, it } from "vitest";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
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
  type BoardOverrides,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { turnStarted, unitDefeated } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_HIIRO_LONEWOLF`（【緋色の一匹狼】榊野ヒイロ）のユニット単位production結合テスト
 * （`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_HIIRO_LONEWOLF";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

/**
 * 攻撃力が最も高い敵を一意にし（`HIGHEST_ATTACK` の解決先を固定する）、EXゲージを
 * 持たせた盤面（0のままでは「1ずつ削る」が観測に現れない）。
 */
const DISTINCT_ATTACK_ENEMIES: BoardOverrides = {
  enemies: [
    {
      id: "enemy:front",
      position: { column: "CENTER", row: "FRONT" },
      state: { combatStats: { ...BOARD_COMBAT_STATS, attack: 2000 }, currentExtraGauge: 3 },
    },
    {
      id: "enemy:left",
      position: { column: "LEFT", row: "FRONT" },
      state: { currentExtraGauge: 3 },
    },
    {
      id: "enemy:back",
      position: { column: "CENTER", row: "BACK" },
      state: { currentExtraGauge: 3 },
    },
  ],
};

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_EX",
    intent:
      "敵全体に威力156で攻撃（回避不可）し、攻撃力が最も高い敵単体に1行動分の気絶を付与する。さらに敵全体に対し、次に受ける攻撃の被ダメージを30%増加させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_LONEWOLF_EX" },
    board: DISTINCT_ATTACK_ENEMIES,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DMG_UP", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DMG_UP", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DMG_UP", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -780,
        "enemy:left": -780,
        "enemy:back": -780,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DMG_UP",
          magnitude: 0.3,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DMG_UP",
          magnitude: 0.3,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_EX_DMG_UP",
          magnitude: 0.3,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS1",
    intent: "攻撃力が最も高い敵が含まれる敵前後列に威力180.72で攻撃し、対象のEXゲージを1ずつ削る",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS1" },
    board: DISTINCT_ATTACK_ENEMIES,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS1_EX_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS1_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS1_EX_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -903,
        "enemy:back": -903,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "EX_GAUGE", delta: -1 },
        { unitId: "enemy:back", resource: "EX_GAUGE", delta: -1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS2",
    intent: "敵前後列に威力180.72で攻撃する（誰も倒れなければEXゲージは増えない）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS2_DAMAGE", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:front": -903,
        "enemy:back": -903,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS2",
    intent: "この攻撃対象を倒した場合、自身のEXゲージを1加算する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS2" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        {
          id: "enemy:back",
          position: { column: "CENTER", row: "BACK" },
          state: { currentHp: 500 },
        },
      ],
    },
    expected: {
      // 撃破そのものがPS2（「自身が敵を倒した際に発動」）の契機になる。
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS2_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_AS2_EX_UP", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "ally:subject": 3500,
        "enemy:front": -903,
        "enemy:back": -500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_HIIRO_LONEWOLF_AS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS1",
    intent:
      "ターン開始時に発動。攻撃力が最も高い敵単体に威力227.52で先制攻撃を行い、対象のPPを全て削る",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS1",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    board: DISTINCT_ATTACK_ENEMIES,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS1_PP_ZERO", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -1137,
      },
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
        { unitId: "enemy:front", resource: "PP", delta: -4 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS1",
    intent: "(不成立): このスキルは戦闘中に一度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS1",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_HIIRO_LONEWOLF_PS1")]: {
              [createRuntimeCounterId("SKL_HIIRO_LONEWOLF_PS1_ACTIVATIONS")]: {
                value: 1,
                carry: 0,
              },
            },
          },
        },
      },
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS2",
    intent:
      "自身が敵を倒した際に発動。自身のHPを最大HPの35%回復する。さらに自身に対し、3回攻撃を受けるまで気絶無効のバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS2",
      trigger: unitDefeated({ unit: "enemy:front", defeatedBy: "ally:subject" }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS2_HEAL", targets: ["ally:subject"] },
        {
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY",
          targets: ["ally:subject"],
        },
      ],
      hpDeltas: {
        "ally:subject": 3500,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_HIIRO_LONEWOLF_PS2_STUN_IMMUNITY",
          magnitude: 0,
          consumption: { kind: "INCOMING_HIT", maxCount: 3 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS2",
    intent: "(不成立): 味方が倒れても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_HIIRO_LONEWOLF_PS2",
      trigger: unitDefeated({ unit: "ally:front", defeatedBy: "enemy:front" }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_HIIRO_LONEWOLF (【緋色の一匹狼】榊野ヒイロ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-HIIRO-LONEWOLF-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-HIIRO-LONEWOLF-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-HIIRO-LONEWOLF-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
