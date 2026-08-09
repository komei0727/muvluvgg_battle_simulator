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
  PRODUCTION_CATALOG_DIR,
  collectedExecutedActionIds,
  observeSkillUse,
  resetExecutedActionIds,
  type BoardUnitSpec,
  type SkillBehaviourCase,
} from "../../../testing/production-unit/skill-behaviour.js";
import { realDamage, skillUseStarting } from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_RAMI_UNYIELDING`(【負けず嫌いな不屈少女】朽葉ラミ)のユニット単位production
 * 結合テスト(`12_テスト戦略.md`「ユニット効果軸」)。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_RAMI_UNYIELDING";

// 混乱（R-CFS-01）を付与するproduction定義は `ACT_OLGA_VETERAN_EX_CONFUSION` の1件だけ。
const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [
  UNIT_DEFINITION_ID,
  "UNIT_OLGA_VETERAN",
]);

/** 既定対象の敵だけがEXの1撃で落ちる残HP。「敵を倒した場合」の成立側を作る。 */
const ENEMY_FRONT_ALMOST_DEAD: readonly BoardUnitSpec[] = [
  { id: "enemy:front", position: { column: "CENTER", row: "FRONT" }, state: { currentHp: 100 } },
  { id: "enemy:left", position: { column: "LEFT", row: "FRONT" } },
  { id: "enemy:back", position: { column: "CENTER", row: "BACK" } },
];

/** PS1は自身のHPが30%以下になった際に発動する。契機の被弾でその境界を跨ぐ残HP。 */
const SUBJECT_NEAR_THRESHOLD = { subject: { state: { currentHp: 3000 } } };

/** PS1は戦闘中1度しか発動しない。発動済みcounterを1に置いて不成立側を作る。 */
const PS1_ALREADY_ACTIVATED = {
  subject: {
    state: {
      currentHp: 3000,
      skillCounters: {
        [createSkillDefinitionId("SKL_RAMI_UNYIELDING_PS1")]: {
          [createRuntimeCounterId("SKL_RAMI_UNYIELDING_PS1_ACTIVATIONS")]: { value: 1, carry: 0 },
        },
      },
    },
  },
};

/**
 * 混乱（R-CFS-01）はASの`DAMAGE` stepのTargetSelectorを反転させ、
 * `SkillUseStarting`/`SkillUseCompleted.targetUnitIds` にも反転後の味方が入る。
 * 「自身がアクティブスキルで攻撃する」ことは変わらないため、この経路でもPSは
 * 発動しなければならない（契機の `targetSelector` を陣営で絞れない理由）。
 * 前提は実 production 定義で作る。
 */
const CONFUSED = [
  { effectActionDefinitionId: "ACT_OLGA_VETERAN_EX_CONFUSION", target: "SELF" },
] as const;

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
    skillDefinitionId: "SKL_RAMI_UNYIELDING_EX",
    intent: "敵横一列に威力156で攻撃し、自身のHPを与えたダメージの30%分回復する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_UNYIELDING_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_HEAL", targets: ["ally:subject"] },
      ],
      // 1体780（威力156%）×2体の合計1560の30%＝468。
      hpDeltas: { "enemy:front": -780, "enemy:left": -780, "ally:subject": 468 },
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_EX",
    intent: "この攻撃で敵倒した場合、敵全体に対し被ダメージを30%増加させるデバフを付与する(重複可)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_UNYIELDING_EX" },
    board: { enemies: ENEMY_FRONT_ALMOST_DEAD },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_HEAL", targets: ["ally:subject"] },
        {
          // 倒した当の敵は戦闘不能のため付与対象から外れる。
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_ENEMY_DMG_UP",
          targets: ["enemy:front"],
          resultKind: "SKIPPED",
        },
        {
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_ENEMY_DMG_UP",
          targets: ["enemy:left"],
        },
        {
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_ENEMY_DMG_UP",
          targets: ["enemy:back"],
        },
      ],
      // HPは残り100しか減らないが、回復が読む「与えたダメージ」は確定ダメージ780×2体
      // であり、その30%＝468になる。
      hpDeltas: { "enemy:front": -100, "enemy:left": -780, "ally:subject": 468 },
      effectsApplied: [
        {
          unitId: "enemy:left",
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_ENEMY_DMG_UP",
          magnitude: 0.3,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
        {
          unitId: "enemy:back",
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_EX_ENEMY_DMG_UP",
          magnitude: 0.3,
          timeLimit: { unit: "BATTLE", count: 1 },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_AS1",
    intent: "敵単体に威力106で攻撃する。自身のHPが少ないほどダメージが増加する(+150%まで)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_UNYIELDING_AS1" },
    expected: {
      // PS3（「自身がアクティブスキルで攻撃する前に発動」）が使用開始の契機で先に走り、
      // その与ダメージ+50%がこの攻撃へ乗る。
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS3_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      // 基礎530（威力106%）にHP割合50%ぶんの増加（上限+150%の半分＝+75%）が乗って927、
      // さらにPS3の+50%が乗って1391（切り捨て）。
      hpDeltas: { "enemy:front": -1391 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_AS1",
    intent: "(HP10%): 自身のHPが少ないほどダメージが増加する(+150%まで)",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_UNYIELDING_AS1" },
    board: { subject: { state: { currentHp: 1000 } } },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS3_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      // HP割合10%では増加は上限の90%＝+135%で1245、さらにPS3の+50%が乗って1868。
      hpDeltas: { "enemy:front": -1868 },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS1",
    intent:
      "自身のHPが30%以下になった際に発動。自身に対し、最大HP×50%までのダメージを防ぐシールドを付与する。シールドは3行動後に消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_UNYIELDING_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: SUBJECT_NEAR_THRESHOLD,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS1_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS1_SHIELD",
          magnitude: 5000,
          timeLimit: { unit: "ACTION", count: 3, owner: "EFFECT_TARGET" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_UNYIELDING_PS1", remaining: 99 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS1",
    intent: "(不成立): HPが30%より多い状態での被弾では発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_UNYIELDING_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS1",
    intent: "(不成立): このスキルは戦闘中に1度しか発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_UNYIELDING_PS1",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "HitPointReduced",
      }),
    },
    board: PS1_ALREADY_ACTIVATED,
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS2",
    intent:
      "自身がアクティブスキルで攻撃される直前に発動。自身に一度だけ致死ダメージをHP1で耐えるバフを付与する。さらに1行動の間、攻撃力を最大80%、行動速度を最大150上昇させるバフを付与する(重複可)。このバフは自身のHPが少ないほど高い効果を発揮する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_UNYIELDING_PS2",
      trigger: realDamage({
        from: "enemy:front",
        to: "ally:subject",
        skillType: "AS",
        event: "UnitBeingAttacked",
      }),
    },
    expected: {
      actions: [
        {
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS2_DEATH_SURVIVAL",
          targets: ["ally:subject"],
        },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS2_ATK_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS2_SPEED_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS2_DEATH_SURVIVAL",
          magnitude: 0,
          timeLimit: { unit: "BATTLE", count: 1 },
          consumption: { kind: "LETHAL_DAMAGE", maxCount: 1 },
        },
        {
          unitId: "ally:subject",
          // 契機の被弾でHPは4500（45%）になっており、上限80%の55%分が乗る。
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS2_ATK_UP",
          magnitude: 0.44000000000000006,
          timeLimit: { unit: "ACTION", count: 1 },
        },
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS2_SPEED_UP",
          magnitude: 82.5,
          timeLimit: { unit: "ACTION", count: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_UNYIELDING_PS2", remaining: 6 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS2",
    intent: "(不成立): 他の味方が攻撃される直前では発動しない(「自身が」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_UNYIELDING_PS2",
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
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3",
    intent:
      "自身がアクティブスキルで攻撃する前に発動。自身に対し、一度だけ与ダメージを50%増加させるバフを付与する(重複可)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "AS",
        skillDefinitionId: "SKL_RAMI_UNYIELDING_AS1",
      }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS3_DMG_UP", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS3_DMG_UP",
          magnitude: 0.5,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3",
    intent: "(不成立): EXスキルの使用前では発動しない(「アクティブスキルで攻撃する前」に限る)",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3",
      trigger: skillUseStarting({
        actor: "ally:subject",
        targets: ["enemy:front"],
        skillType: "EX",
        skillDefinitionId: "SKL_RAMI_UNYIELDING_EX",
      }),
      triggeredBy: "ally:subject",
    },
    expected: { activated: false },
  },
  {
    skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3",
    intent:
      "(発動): 混乱で攻撃対象が味方側へ反転しても、アクティブスキルで攻撃する事実は変わらず発動する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_RAMI_UNYIELDING_AS1" },
    precedingActions: CONFUSED,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_PS3_DMG_UP", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_RAMI_UNYIELDING_AS1_DAMAGE", targets: ["ally:subject"] },
      ],
      // PS3の+50%が乗った1391に、混乱の被ダメージ30%減少が掛かって973。
      hpDeltas: { "ally:subject": -973 },
      effectsRemoved: [CONFUSION_CONSUMED],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 2 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_RAMI_UNYIELDING_PS3", remaining: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_RAMI_UNYIELDING (【負けず嫌いな不屈少女】朽葉ラミ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-RAMI-UNYIELDING-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-RAMI-UNYIELDING-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-RAMI-UNYIELDING-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
