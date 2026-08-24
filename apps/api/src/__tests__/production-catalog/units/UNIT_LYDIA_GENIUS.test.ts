import { describe, expect, it } from "vitest";
import { loadProductionSnapshot, unitFrom } from "../../../testing/fixtures/index.js";
import {
  effectKindKeyFromDefinitionId,
  type AppliedEffect,
} from "../../../domain/battle/model/applied-effect.js";
import {
  createEffectActionDefinitionId,
  createRuntimeCounterId,
  createSkillDefinitionId,
} from "../../../domain/catalog/definitions/catalog-ids.js";
import { createEffectInstanceId } from "../../../domain/shared/event-ids.js";
import { createBattleUnitId } from "../../../domain/shared/ids.js";
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
  selectedActiveSkill,
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
/**
 * ステルス状態の相手役。実定義は検証対象ユニットのスナップショットに載らないため
 * （`loadProductionSnapshot` は対象ユニット分しか読まない）、`statusKind` だけを
 * 同じ値で組み立てる。剥がれたかどうかは実 `resolveTargets` の判定が決める。
 */
function stealthStatus(targetUnitId: string): AppliedEffect {
  const definitionId = createEffectActionDefinitionId("ACT_TEST_STEALTH");
  return {
    effectInstanceId: createEffectInstanceId(`B_BEHAVIOUR:stealth:${targetUnitId}`),
    effectActionDefinitionId: definitionId,
    kindKey: effectKindKeyFromDefinitionId(definitionId),
    duplicate: true,
    sourceUnitId: createBattleUnitId(targetUnitId),
    targetUnitId: createBattleUnitId(targetUnitId),
    magnitude: 0,
    categories: ["BUFF"],
    statusKind: "STEALTH",
    duration: { definition: { dispellable: true, linkedEffectGroupId: null } },
    appliedTurnNumber: 1,
  };
}

const CENTER_ONLY_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** 左右両方の列に敵が居る盤面。右列の1体は後列でもある（2つのbindingが重なる）。 */
const BOTH_COLUMNS_ENEMIES: readonly BoardUnitSpec[] = [
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:right", position: { column: "RIGHT", row: "BACK" } },
  { id: "enemy:center", position: { column: "CENTER", row: "FRONT" } },
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
      // 568（(1000-500)×113.76%）。後列は会心確定で、会心倍率1.5倍は切り捨て前に
      // 掛かるため568.8×1.5の切り捨て853になる。
      hpDeltas: {
        "enemy:left": -568,
        "enemy:back": -853,
      },
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_EX",
    intent:
      "(不発動): 左右列に敵が居なくても後列に敵が居れば「上記の対象範囲」は空ではないため、代替攻撃は行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
    board: { enemies: CENTER_ONLY_ENEMIES },
    expected: {
      // 代替攻撃の条件は左右列と後列を**合わせた**範囲が空であること。中央後列の
      // 敵が後列bindingに入るため、中央前列の敵は最後まで対象にならない。
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_BACKROW_CRIT",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:back": -853,
      },
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_EX",
    intent: "上記の対象範囲に敵が存在しない場合、代わりに最も近い敵単体に威力100で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
    board: {
      enemies: [{ id: "enemy:front", position: { column: "CENTER", row: "FRONT" } }],
    },
    expected: {
      // 中央前列の1体だけなので左右列も後列も空になる。列攻撃の113.76%ではなく
      // 代替攻撃の100%が乗り、(1000-500)×100%＝500になる。
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_FALLBACK",
          targets: ["enemy:front"],
        },
      ],
      hpDeltas: {
        "enemy:front": -500,
      },
    },
  },
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_EX",
    intent: "(不発動): 中央後列の1体だけでも後列攻撃が成立するため、代替攻撃は行わない",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
    board: {
      enemies: [{ id: "enemy:back", position: { column: "CENTER", row: "BACK" } }],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_BACKROW_CRIT",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:back": -853,
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
  {
    skillDefinitionId: "SKL_LYDIA_GENIUS_EX",
    intent: "同上: 後列に敵がいなくても、左右列への攻撃は成立する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX", actionType: "EX" },
    board: {
      enemies: [
        { id: "enemy:front", position: { column: "CENTER", row: "FRONT" } },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
      ],
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_COLUMN",
          targets: ["enemy:left"],
        },
      ],
      hpDeltas: {
        "enemy:left": -568,
      },
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

  it("IT-UNIT-LYDIA-GENIUS-004 [R-ACT-02] (R-ACT-02): AS1の実 TARGET_SET_COUNT は行動選択層で評価され、右列にも左列にも敵が居ない盤面ではAS1が候補から外れて宣言順の次のAS2が選ばれる", () => {
    // 既定盤面は左列に敵が居るため集合が1体以上ある。
    expect(selectedActiveSkill({ snapshot, unitDefinitionId: UNIT_DEFINITION_ID })).toBe(
      "SKL_LYDIA_GENIUS_AS1",
    );

    // `TARGET_SET_COUNT` が見る `TGT_COLUMNS` はこのスキル自身のbindingでもあるため、
    // 集合が空になる不成立はR-TGT-01 #4（空bindingは常に発動不能）とも重なる。
    // 条件評価パイプラインがそこでスローせず候補除外として扱われることの証跡。
    expect(
      selectedActiveSkill({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        board: { enemies: CENTER_ONLY_ENEMIES },
      }),
    ).toBe("SKL_LYDIA_GENIUS_AS2");
  });

  it("IT-UNIT-LYDIA-GENIUS-005 [R-TGT-09, R-TGT-10] (R-TGT-09/R-TGT-10): EXの実 `OR(POSITION_COLUMN RIGHT, LEFT)` は左右どちらの列も拾って中央列を外し、同じ使用の `POSITION_ROW BACK` は後列だけを拾う。左右が候補0件でも後列が候補を持つ限り、列側のstepが素通りするだけで済む", () => {
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
        board: { enemies: BOTH_COLUMNS_ENEMIES },
      }),
    ).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_COLUMN", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_COLUMN", targets: ["enemy:right"] },
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_BACKROW_CRIT",
          targets: ["enemy:right"],
        },
      ],
      // 中央列の敵はどちらのbindingにも入らない。右列後段の敵だけが列への一撃
      // （568）と後列への会心攻撃（853）を重ねて受ける。
      hpDeltas: {
        "enemy:left": -568,
        "enemy:right": -1421,
      },
    });

    // 左右列が候補0件でも、後列が候補を持つ限り「上記の対象範囲」は空ではない。
    // `TGT_COLUMNS` 側のstepが対象0件で素通りするだけで、中央前列の敵は
    // どのbindingにも入らないまま無傷で残る。
    expect(
      observeSkillUse({
        snapshot,
        unitDefinitionId: UNIT_DEFINITION_ID,
        use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
        board: { enemies: CENTER_ONLY_ENEMIES },
      }),
    ).toEqual({
      actions: [
        {
          effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_BACKROW_CRIT",
          targets: ["enemy:back"],
        },
      ],
      hpDeltas: {
        "enemy:back": -853,
      },
    });
  });

  it("IT-UNIT-LYDIA-GENIUS-007 (R-TGT-08 #7/R-TGT-10): 代替攻撃のbindingは分岐が不成立でも評価されるが、`POSITION_SLOT` で定義上1体へ限定されているためステルスを消費しない", () => {
    // R-TGT-10により全targetBindingはEffectSequence開始時に評価され、そこで検出した
    // ステルス消費はstep実行前に適用される。代替攻撃のbindingが「最も近い敵」のような
    // 盤面依存のselectorだと、分岐が不成立で一度も攻撃しないまま第一優先対象の
    // ステルスを剥がしてしまう（R-TGT-08 #2〜#4）。代替攻撃の条件が成立する盤面では
    // 生存する敵は中央前列の1体に限られるため、`POSITION_SLOT` で構造的に1体へ
    // 限定し、R-TGT-08 #7の非適用側へ寄せている。
    const observed = observeSkillUse({
      snapshot,
      unitDefinitionId: UNIT_DEFINITION_ID,
      use: { kind: "ACTIVE", skillDefinitionId: "SKL_LYDIA_GENIUS_EX" },
      board: {
        subject: { position: { column: "CENTER", row: "FRONT" } },
        enemies: [
          { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
          {
            id: "enemy:center",
            position: { column: "CENTER", row: "FRONT" },
            state: { appliedEffects: [stealthStatus("enemy:center")] },
          },
        ],
      },
    });

    // 左列に敵が居るので代替攻撃の分岐は不成立。中央前列へは攻撃もステルス消費も
    // 起きず、`effectsRemoved` がキーごと現れないことがそれを固定する。
    expect(observed).toEqual({
      actions: [
        { effectActionDefinitionId: "ACT_LYDIA_GENIUS_EX_DAMAGE_COLUMN", targets: ["enemy:left"] },
      ],
      hpDeltas: { "enemy:left": -568 },
    });
  });

  it("IT-UNIT-LYDIA-GENIUS-006 (R-EFF-11): PS2 が宣言する発動回数counterは、自分自身の PassiveActivated でだけ増える。このユニットのものではないPSの発動では動かない", () => {
    // counterの増減は `-001` の振る舞い表の観測に載らない（表はスキル使用1回が
    // 起こしたことを見るもので、`RuntimeCounterChanged` は契機イベントから
    // `detectRuntimeCounterUpdates` が独立に起こす）。宣言は実 `catalog/` の
    // ユニット定義から導くため、counterを持つPSが増えれば行が増えて落ちる。
    expect(observeActivationCounters(snapshot, UNIT_DEFINITION_ID)).toEqual({
      declarations: [
        {
          skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
          counter: "SKL_LYDIA_GENIUS_PS2_ACTIVATIONS",
          scope: "SKILL_RUNTIME",
          amount: 1,
        },
      ],
      changesByActivatedSkill: {
        SKL_LYDIA_GENIUS_PS2: [
          {
            skillDefinitionId: "SKL_LYDIA_GENIUS_PS2",
            counter: "SKL_LYDIA_GENIUS_PS2_ACTIVATIONS",
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
