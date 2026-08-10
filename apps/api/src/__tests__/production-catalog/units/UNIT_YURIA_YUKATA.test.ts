import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import {
  unexecutedEffectActionIds,
  unitEffectActionClosure,
} from "../../../testing/production-unit/definition-closure.js";
import { observeActivationCounters } from "../../../testing/production-unit/runtime-counter.js";
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_YURIA_YUKATA`（【はだけるわんぱく浴衣】ユリア・バーンズ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_YURIA_YUKATA";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_OLGA_VETERAN",
]);

/** PS1は自身のAS完了そのものを契機に持つため、攻撃ASの観測には必ず連鎖が含まれる。 */
const PS1_CHAIN_ACTIONS = [
  { effectActionDefinitionId: "ACT_YURIA_YUKATA_PS1_ATK_UP", targets: ["ally:subject"] },
  { effectActionDefinitionId: "ACT_YURIA_YUKATA_PS1_ATK_UP", targets: ["ally:front"] },
] as const;

/** 前列の味方は自身（CENTER FRONT）と ally:front（LEFT FRONT）の2体。 */
const PS1_CHAIN_EFFECTS = [
  {
    unitId: "ally:subject",
    effectActionDefinitionId: "ACT_YURIA_YUKATA_PS1_ATK_UP",
    magnitude: 0.125,
    timeLimit: { unit: "ACTION", count: 2 },
  },
  {
    unitId: "ally:front",
    effectActionDefinitionId: "ACT_YURIA_YUKATA_PS1_ATK_UP",
    magnitude: 0.125,
    timeLimit: { unit: "ACTION", count: 2 },
  },
] as const;

const PS1_COOLDOWN = {
  unitId: "ally:subject",
  skillDefinitionId: "SKL_YURIA_YUKATA_PS1",
  remaining: 3,
} as const;

/**
 * 混乱（R-CFS-01）はASの`DAMAGE` stepのTargetSelectorを反転させ、
 * `SkillUseStarting`/`SkillUseCompleted.targetUnitIds` にも反転後の味方が入る。
 * 「自身がアクティブスキルで攻撃する」ことは変わらないため、この経路でもPSは
 * 発動しなければならない。前提は実 production 定義で作る。
 */
const CONFUSED: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", target: "SELF" },
];

/** 混乱はその行動の`DAMAGE`で消費され、観測では解除として現れる。 */
const CONFUSION_CONSUMED = {
  unitId: "ally:subject",
  effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION",
  magnitude: 0,
  timeLimit: { unit: "ACTION", count: 1 },
  statusKind: "CONFUSION",
} as const;

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_YURIA_YUKATA_EX",
    intent:
      "前列優先で敵横一列に威力117で攻撃し、1行動の間行動速度を100、会心率を17.5%低下させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_YUKATA_EX" },
    expected: {
      // 基準は前列の敵、横一列はその敵と同じ行。後列の enemy:back には届かない。
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_SPEED_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_CRIT_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_SPEED_DOWN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_CRIT_DOWN", targets: ["enemy:left"] },
      ],
      hpDeltas: {
        "enemy:front": -585,
        "enemy:left": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_SPEED_DOWN",
          magnitude: -100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_CRIT_DOWN",
          magnitude: -0.175,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_SPEED_DOWN",
          magnitude: -100,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_EX_CRIT_DOWN",
          magnitude: -0.175,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_YUKATA_AS1",
    intent: "敵単体に威力106で2ヒット攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_YUKATA_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_AS1_DAMAGE", targets: ["enemy:front"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      // 1ヒット530（(1000-500)×106%）×2ヒット。
      hpDeltas: {
        "enemy:front": -1060,
      },
      effectsApplied: [...PS1_CHAIN_EFFECTS],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_YURIA_YUKATA_AS1", remaining: 1 },
        PS1_COOLDOWN,
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_YUKATA_AS2",
    intent:
      "自身を含む横一列の味方に対し、1行動の間与ダメージを35%増加させ、被ダメージを35%減少させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_YUKATA_AS2" },
    expected: {
      // PS1は「攻撃した後」の連鎖なので、敵を対象に取らないこのASでは発動しない。
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_DOWN", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_UP", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_DOWN", targets: ["ally:front"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_UP",
          magnitude: 0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_DOWN",
          magnitude: -0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_UP",
          magnitude: 0.35,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_AS2_DMG_DOWN",
          magnitude: -0.35,
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
    skillDefinitionId: "SKL_YURIA_YUKATA_PS1",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。2行動の間、前列の味方の攻撃力を12.5%上昇させる（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_YUKATA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_YURIA_YUKATA_AS1",
      }),
    },
    expected: {
      actions: [...PS1_CHAIN_ACTIONS],
      effectsApplied: [...PS1_CHAIN_EFFECTS],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_YUKATA_PS1",
    intent: "(不成立): 敵を攻撃しないAS（みんなで温泉入ろ♪）の完了では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_YUKATA_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["ally:subject", "ally:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_YURIA_YUKATA_AS2",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_YUKATA_PS2",
    intent:
      "ターン開始時に発動。味方全体に対し、自身の最大HP×45%のシールドを付与する。シールドはスキル発動者の2行動後に消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_YUKATA_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_PS2_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_PS2_SHIELD", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_PS2_SHIELD", targets: ["ally:back"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_PS2_SHIELD",
          // 発動者の最大HP10000 × 45%。
          magnitude: 4500,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:front",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_PS2_SHIELD",
          magnitude: 4500,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
        {
          unitId: "ally:back",
          effectActionDefinitionId: "ACT_YURIA_YUKATA_PS2_SHIELD",
          magnitude: 4500,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_YURIA_YUKATA_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_YURIA_YUKATA_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_YURIA_YUKATA_PS2")]: {
              [createRuntimeCounterId("SKL_YURIA_YUKATA_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
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
    skillDefinitionId: "SKL_YURIA_YUKATA_PS1",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃した事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_YURIA_YUKATA_AS1" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_YURIA_YUKATA_AS1_DAMAGE", targets: ["ally:subject"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      // 混乱倍率0.7が掛かった1ヒット371×2ヒット。
      hpDeltas: {
        "ally:subject": -742,
      },
      effectsApplied: [...PS1_CHAIN_EFFECTS],
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 3 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_YURIA_YUKATA_AS1", remaining: 1 },
        PS1_COOLDOWN,
      ],
    },
  },
];

describe("production Catalog UNIT_YURIA_YUKATA (【はだけるわんぱく浴衣】ユリア・バーンズ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-YURIA-YUKATA-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-YURIA-YUKATA-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-YURIA-YUKATA-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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

  it("IT-UNIT-YURIA-YUKATA-004 (R-EFF-11): PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_YURIA_YUKATA_PS2",
          counter: "SKL_YURIA_YUKATA_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_YURIA_YUKATA_PS2: [
          {
            skillDefinitionId: "SKL_YURIA_YUKATA_PS2",
            counter: "SKL_YURIA_YUKATA_PS2_ACTIVATIONS",
            before: 0,
            after: 1,
            valueChanged: true,
          },
        ],
      },
      changesOnUnrelatedSkill: [],
    });
  });
});
