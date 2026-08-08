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
  type PrecedingAction,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import {
  effectApplied,
  skillUseStarting,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_MEIYA_FATED`（【天命を受けし剣術乙女】御剣冥夜）のユニット単位production
 * 結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_MEIYA_FATED";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_OLGA_VETERAN",
]);

/**
 * PS1の`REMOVE_EFFECTS`は解除対象のデバフが先に載っていないと何も起こさない。
 * 手組みの`AppliedEffect`ではなく、AS1が実際に配るデバフを自身へ撃って前提を作る。
 */
const SELF_DEBUFF: readonly PrecedingAction[] = [
  { effectActionDefinitionId: "ACT_MEIYA_FATED_AS1_DMG_DOWN", target: "SELF" },
];

/** PS2は自身のAS開始そのものを契機に持つため、AS 1回の観測には必ず連鎖が含まれる。 */
const PS2_CHAIN_ACTIONS = [
  { effectActionDefinitionId: "ACT_MEIYA_FATED_PS2_CRIT_UP", targets: ["ally:subject"] },
  { effectActionDefinitionId: "ACT_MEIYA_FATED_PS2_CRIT_DMG_UP", targets: ["ally:subject"] },
] as const;

/**
 * 攻撃対象（既定盤面では最大HPの50%）のHP割合で決まる上昇量。
 * 会心率は最高40%、会心ダメージは最高25%なので、半分のHPならそれぞれ半分になる。
 */
const PS2_CHAIN_EFFECTS = [
  {
    unitId: "ally:subject",
    effectActionDefinitionId: "ACT_MEIYA_FATED_PS2_CRIT_UP",
    magnitude: 0.2,
    consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
  },
  {
    unitId: "ally:subject",
    effectActionDefinitionId: "ACT_MEIYA_FATED_PS2_CRIT_DMG_UP",
    magnitude: 0.125,
    consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
  },
] as const;

const PS2_COOLDOWN = {
  unitId: "ally:subject",
  skillDefinitionId: "SKL_MEIYA_FATED_PS2",
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
    skillDefinitionId: "SKL_MEIYA_FATED_EX",
    intent:
      "敵単体に威力49.92で5ヒット攻撃し、1行動分の気絶を付与する。さらに自身に対し、次に受ける攻撃の被ダメージを75%減少させる効果を付与する（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MEIYA_FATED_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_MEIYA_FATED_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_EX_STUN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_EX_DMG_REDUCTION", targets: ["ally:subject"] },
      ],
      // 1ヒット249（(1000-500)×49.92%）×5ヒット。
      hpDeltas: {
        "enemy:front": -1245,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_EX_DMG_REDUCTION",
          magnitude: -0.75,
          consumption: { kind: "NEXT_INCOMING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MEIYA_FATED_EX_STUN",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
          statusKind: "STUN",
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_AS1",
    intent:
      "敵単体に威力212で攻撃し、1行動の間与ダメージを20%減少させるデバフを付与する（重複可）。また、1行動の間対象の行動速度を80低下させる",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MEIYA_FATED_AS1" },
    expected: {
      actions: [
        ...PS2_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS1_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS1_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS1_SPD_DOWN", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -1060,
      },
      // PS2が付けた会心バフは`NEXT_OUTGOING_ATTACK`消費で、続くこのAS自身の攻撃が
      // 消費し切るため観測の差分には残らない（原文「このスキルに続く自身の攻撃での」）。
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MEIYA_FATED_AS1_DMG_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_MEIYA_FATED_AS1_SPD_DOWN",
          magnitude: -80,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        PS2_COOLDOWN,
        { unitId: "ally:subject", skillDefinitionId: "SKL_MEIYA_FATED_AS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_AS2",
    intent:
      "敵単体に威力156で攻撃し、与えたダメージの70%分自身のHPを回復する。さらに自身の攻撃力を4%上昇させる（重複可）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MEIYA_FATED_AS2" },
    expected: {
      actions: [
        ...PS2_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_ATK_UP", targets: ["ally:subject"] },
      ],
      // 780ダメージ（(1000-500)×156%）の70%を回復。
      hpDeltas: {
        "ally:subject": 546,
        "enemy:front": -780,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_ATK_UP",
          magnitude: 0.04,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_PS1",
    intent:
      "自身にデバフが付与された際に発動。デバフをすべて解除し、1行動の間、自身に向けられるデバフを無効にするバフを付与する。さらに攻撃力×55%のシールドを付与し、自身の攻撃力を1行動の間20%上昇させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MEIYA_FATED_PS1",
      trigger: effectApplied({
        source: "enemy:front",
        target: "ally:subject",
        effectKind: "APPLY_DAMAGE_MOD",
        categories: ["DEBUFF"],
      }),
    },
    precedingActions: SELF_DEBUFF,
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_MEIYA_FATED_PS1_REMOVE_DEBUFF",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_PS1_IMMUNITY", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_PS1_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_PS1_ATK_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_PS1_IMMUNITY",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_PS1_SHIELD",
          // 攻撃力1000 × 55%。
          magnitude: 550,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_PS1_ATK_UP",
          magnitude: 0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      // 前提で自身へ載せたデバフが実際に解除される。
      effectsRemoved: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_AS1_DMG_DOWN",
          magnitude: -0.2,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_MEIYA_FATED_PS1", remaining: 2 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_PS1",
    intent: "(不成立): デバフ以外の効果が自身に付与されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MEIYA_FATED_PS1",
      trigger: effectApplied({
        source: "ally:front",
        target: "ally:subject",
        effectKind: "APPLY_STAT_MOD",
        categories: ["BUFF"],
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_PS2",
    intent:
      "自身がアクティブスキルで攻撃する前に発動。このスキルに続く自身の攻撃での会心を最高40%、会心ダメージを最高25%上昇させる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MEIYA_FATED_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MEIYA_FATED_AS1",
      }),
    },
    expected: {
      actions: [...PS2_CHAIN_ACTIONS],
      effectsApplied: [...PS2_CHAIN_EFFECTS],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_PS2",
    intent: "(境界): 攻撃対象のHPが多いほど高い効果を発揮する — 満タンなら最高値になる",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MEIYA_FATED_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_MEIYA_FATED_AS1",
      }),
    },
    board: {
      enemies: [
        {
          id: "enemy:front",
          position: { column: "CENTER", row: "FRONT" },
          state: { currentHp: 10000 },
        },
        { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
        { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
      ],
    },
    expected: {
      actions: [...PS2_CHAIN_ACTIONS],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_PS2_CRIT_UP",
          magnitude: 0.4,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_PS2_CRIT_DMG_UP",
          magnitude: 0.25,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_PS2",
    intent: "(不成立): 同じく攻撃するEXの使用開始では発動しない（アクティブスキルではない）",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_MEIYA_FATED_PS2",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_MEIYA_FATED_EX",
      }),
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_MEIYA_FATED_PS2",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃する事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_MEIYA_FATED_AS2" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        ...PS2_CHAIN_ACTIONS,
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_DAMAGE", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_HEAL", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_ATK_UP", targets: ["ally:subject"] },
      ],
      // 混乱倍率0.7で546ダメージ、その70%を同じ自身へ回復するため差引-164。
      hpDeltas: {
        "ally:subject": -164,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_MEIYA_FATED_AS2_ATK_UP",
          magnitude: 0.04,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [PS2_COOLDOWN],
    },
  },
];

describe("production Catalog UNIT_MEIYA_FATED (【天命を受けし剣術乙女】御剣冥夜)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-MEIYA-FATED-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-MEIYA-FATED-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-MEIYA-FATED-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
