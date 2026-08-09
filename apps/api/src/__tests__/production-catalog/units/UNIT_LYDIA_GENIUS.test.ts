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
import {
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { skillUseCompleted, turnStarted } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LYDIA_GENIUS`（【純真無垢なるジーニアス】リディア・エルドリッジ）のユニット
 * 単位production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LYDIA_GENIUS";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_OLGA_VETERAN",
]);

/** 右列にも左列にも敵が居ない盤面（中央列だけ）。 */
const CENTER_ONLY_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** PS1は自身のAS完了そのものを契機に持つため、攻撃ASの観測には必ず連鎖が含まれる。 */
const PS1_CHAIN_ACTIONS = [
  { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF", targets: ["ally:subject"] },
  { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF", targets: ["ally:front"] },
  { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF", targets: ["ally:back"] },
] as const;

/** 味方1体あたりの減少量と、既定盤面の生存味方数（自身＋2体）。 */
const PER_ALLY = -0.05;
const ALIVE_ALLY_COUNT = 3;

/** 生存している味方3体 × 5%。最大25%までしか伸びない。 */
const PS1_CHAIN_EFFECTS = [
  {
    unitId: "ally:subject",
    effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF",
    magnitude: ALIVE_ALLY_COUNT * PER_ALLY,
    consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
  },
  {
    unitId: "ally:front",
    effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF",
    magnitude: ALIVE_ALLY_COUNT * PER_ALLY,
    consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
  },
  {
    unitId: "ally:back",
    effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF",
    magnitude: ALIVE_ALLY_COUNT * PER_ALLY,
    consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
  },
] as const;

const PS1_COOLDOWN = {
  unitId: "ally:subject",
  skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
  remaining: 1,
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
    skillDefinitionId: "SKL_LYDIA_GENIUS_EX",
    intent: "敵右列・左列に威力113.76で攻撃する。さらに後列横一列に威力113.76で会心攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_COLUMN", targets: ["enemy:left"] },
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_BACKROW_CRIT",
          targets: ["enemy:back"],
        },
      ],
      // 568（(1000-500)×113.76%）。後列は会心確定で、会心倍率2倍は切り捨て前に
      // 掛かるため568.8×2の切り捨て1137になる。
      hpDeltas: {
        "enemy:left": -568,
        "enemy:back": -1137,
      },
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_EX",
    intent: "(対象): 上記の対象範囲に敵が存在しない場合、代わりに最も近い敵単体に攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
    board: { enemies: CENTER_ONLY_ENEMIES },
    expected: {
      // 右列・左列に敵が居ないため、列への一撃が最も近い敵へ振り替わる。
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_COLUMN", targets: ["enemy:front"] },
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_BACKROW_CRIT",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:front": -568,
        "enemy:back": -1137,
      },
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_AS1",
    intent:
      "敵右列および左列に威力70.2で攻撃し、自身に対し与ダメージを2.5%増加させるバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS1_SELF_BUFF", targets: ["ally:subject"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      hpDeltas: {
        "enemy:left": -351,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS1_SELF_BUFF",
          magnitude: 0.025,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        ...PS1_CHAIN_EFFECTS,
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LYDIA_GENIUS_AS1", remaining: 1 },
        PS1_COOLDOWN,
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_AS1",
    intent: "(不成立): 対象範囲に敵が存在しない場合、このスキルは発動しない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_AS1" },
    board: { enemies: CENTER_ONLY_ENEMIES },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_AS2",
    intent:
      "敵単体に威力20で2ヒット攻撃する。攻撃後に対象が生存していた場合、さらに威力53でもう一度攻撃を行い、対象の次の攻撃の与ダメージを20%減少させるデバフを付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_AS2" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DAMAGE1", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DAMAGE2", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DEBUFF", targets: ["enemy:front"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      // 1ヒット100（(1000-500)×20%）×2ヒット、追撃265（同×53%）。
      hpDeltas: {
        "enemy:front": -465,
      },
      effectsApplied: [
        ...PS1_CHAIN_EFFECTS,
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DEBUFF",
          magnitude: -0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_AS2",
    intent: "(分岐): 2ヒットで対象が倒れた場合、追撃もデバフも行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_AS2" },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 100 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DAMAGE1", targets: ["enemy:front"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      hpDeltas: {
        "enemy:front": -100,
      },
      effectsApplied: [...PS1_CHAIN_EFFECTS],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
    intent:
      "自身がアクティブスキルで攻撃した後に発動。味方全体に対し、次に受ける攻撃の被ダメージを最大25%減少させる効果を付与する（重複可）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_LYDIA_GENIUS_AS1",
      }),
    },
    expected: {
      actions: [...PS1_CHAIN_ACTIONS],
      effectsApplied: [...PS1_CHAIN_EFFECTS],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
    intent: "(境界): このバフは生存している味方の数が多いほど高い効果を発揮する — 上限は25%",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_LYDIA_GENIUS_AS1",
      }),
    },
    board: {
      allies: [
        { id: "ally:front", position: { column: "LEFT", row: "FRONT" } },
        { id: "ally:right", position: { column: "RIGHT", row: "FRONT" } },
        { id: "ally:back", position: { column: "CENTER", row: "BACK" } },
        { id: "ally:back-left", position: { column: "LEFT", row: "BACK" } },
        { id: "ally:back-right", position: { column: "RIGHT", row: "BACK" } },
      ],
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF", targets: ["ally:front"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF", targets: ["ally:right"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF", targets: ["ally:back"] },
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF",
          targets: ["ally:back-left"],
        },
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF",
          targets: ["ally:back-right"],
        },
      ],
      effectsApplied: [
        "ally:subject",
        "ally:front",
        "ally:right",
        "ally:back",
        "ally:back-left",
        "ally:back-right",
      ].map((unitId) => ({
        unitId,
        effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS1_SHIELD_BUFF",
        magnitude: -0.25,
        consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
      })),
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
    intent:
      "ターン開始時に発動。自身から最も遠い位置にいる敵単体に威力78で先制攻撃してPPを2削り、2行動の間HP回復量を50%減少させるデバフを付与する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
      trigger: turnStarted({ turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS2_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS2_PP_DOWN", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS2_HEALING_DOWN", targets: ["enemy:back"] },
      ],
      hpDeltas: {
        "enemy:back": -390,
      },
      effectsApplied: [
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_PS2_HEALING_DOWN",
          magnitude: -0.5,
          timeLimit: { unit: "ACTION", count: 2 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -2 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
        { unitId: "enemy:back", resource: "PP", delta: -2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
      trigger: turnStarted({ turnNumber: 2 }),
      triggeredBy: "ally:subject",
      turnNumber: 2,
    },
    board: {
      subject: {
        state: {
          skillCounters: {
            [createSkillDefinitionId("SKL_LYDIA_GENIUS_PS2")]: {
              [createRuntimeCounterId("SKL_LYDIA_GENIUS_PS2_ACTIVATIONS")]: { value: 1, carry: 0 },
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
    skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃した事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_AS2" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DAMAGE1", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DAMAGE2", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DEBUFF", targets: ["ally:subject"] },
        ...PS1_CHAIN_ACTIONS,
      ],
      // 混乱倍率0.7が掛かった 70×2ヒット + 185。
      hpDeltas: {
        "ally:subject": -325,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_AS2_DEBUFF",
          magnitude: -0.2,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        ...PS1_CHAIN_EFFECTS,
      ],
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS1_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
    intent: "(不成立): 同じく攻撃するEXの使用完了では発動しない（アクティブスキルではない）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LYDIA_GENIUS_PS1",
      trigger: skillUseCompleted({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_LYDIA_GENIUS_EX",
      }),
    },
    expected: {
      activated: false,
    },
  },
];

describe("production Catalog UNIT_LYDIA_GENIUS (【純真無垢なるジーニアス】リディア・エルドリッジ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LYDIA-GENIUS-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LYDIA-GENIUS-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LYDIA-GENIUS-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
