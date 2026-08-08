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
import {
  turnCompleting,
  turnStarted,
  unitBeingAttacked,
} from "../../../testing/production-unit/trigger-events.js";

/**
 * `UNIT_LUNA_HUNGRY`（【博識なハングリーガール】ルナ・メロウ）のユニット単位
 * production結合テスト（`12_テスト戦略.md`「ユニット効果軸」）。
 *
 * 単位は**スキル使用1回**。実 `catalog/` の未改変定義を実経路へ通し、下表が
 * 「発動したか」「誰が対象になったか」「どの分岐の腕が選ばれたか」「何が起きたか」
 * を1行ずつ宣言する。`intent` は原文の該当句で、`raw/` がCIに存在しない以上、
 * 転記が正しいかをレビューできる唯一の接点になる。
 */

const UNIT_DEFINITION_ID = "UNIT_LUNA_HUNGRY";

const snapshot = loadProductionSnapshot(PRODUCTION_CATALOG_DIR, [UNIT_DEFINITION_ID]);

const POWERFUL_MARKER_ID = "MARKER_LUNA_HUNGRY_POWERFUL";

/** 「パワフル」状態はPS3が付けるMarkerで、AS1の分岐条件になる。 */
const POWERFUL: BoardOverrides = { subject: { markers: [{ markerId: POWERFUL_MARKER_ID }] } };

/** (SKL_ID, 原文の該当句, 前提盤面, 期待する振る舞い)。 */
const BEHAVIOURS: readonly SkillBehaviourCase[] = [
  {
    skillDefinitionId: "SKL_LUNA_HUNGRY_EX",
    intent:
      "敵全体に威力109.2で攻撃し、自身に対し、最大HP×40%のシールドを付与する。シールドは2行動後に消滅する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUNA_HUNGRY_EX" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_EX_DAMAGE", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_EX_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_EX_DAMAGE", targets: ["enemy:back"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_EX_SHIELD", targets: ["ally:subject"] },
      ],
      hpDeltas: {
        "enemy:front": -546,
        "enemy:left": -546,
        "enemy:back": -546,
      },
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUNA_HUNGRY_EX_SHIELD",
          // 最大HP10000 × 40%。
          magnitude: 4000,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUNA_HUNGRY_AS1",
    intent: "敵単体に威力117で攻撃する（「パワフル」状態にない場合はこの一撃だけ）",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUNA_HUNGRY_AS1" },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_AS1_DAMAGE", targets: ["enemy:front"] },
      ],
      hpDeltas: {
        "enemy:front": -585,
      },
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUNA_HUNGRY_AS1",
    intent:
      "自身が「パワフル」状態の場合、この攻撃は会心攻撃となり、対象の次の攻撃の与ダメージを30%減少させるデバフを付与する（重複可）。さらに自身が「パワフル」状態の場合、対象に隣接する2体にも威力117で攻撃する",
    use: { kind: "ACTIVE", skillDefinitionId: "SKL_LUNA_HUNGRY_AS1" },
    board: POWERFUL,
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_AS1_DAMAGE_CRIT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_AS1_DMG_DOWN", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_AS1_DAMAGE", targets: ["enemy:left"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_AS1_DAMAGE", targets: ["enemy:back"] },
      ],
      // 会心確定の一撃は会心倍率（1.5 + 会心ダメージ補正0.5）で585 × 2、
      // 隣接2体は会心指定のない585。
      hpDeltas: {
        "enemy:front": -1170,
        "enemy:left": -585,
        "enemy:back": -585,
      },
      effectsApplied: [
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUNA_HUNGRY_AS1_DMG_DOWN",
          magnitude: -0.3,
          consumption: { kind: "NEXT_OUTGOING_ATTACK", maxCount: 1 },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "AP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUNA_HUNGRY_PS1",
    intent:
      "（同時発動制限）他の味方が攻撃される前に発動。行動が終了するまでの間攻撃を自身に引き寄せてダメージを肩代わりし、受けたダメージの75%を反射する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUNA_HUNGRY_PS1",
      trigger: unitBeingAttacked({ source: "enemy:front", target: "ally:front" }),
    },
    expected: {
      // 引き寄せ・肩代わりの状態は**攻撃側**が保持する（効果対象は`TRIGGER_SOURCE`）。
      actions: [
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS1_REDIRECT", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS1_COVER", targets: ["enemy:front"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS1_REFLECT", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS1_REFLECT",
          // 反射量は反射のたびに「直前に受けたダメージ」から評価し直すため、
          // 付与時の`magnitude`は0のままになる。
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS1_REDIRECT",
          magnitude: 0,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
        {
          unitId: "enemy:front",
          effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS1_COVER",
          // 肩代わり率100%（ダメージを全部引き受ける）。
          magnitude: 1,
          timeLimit: { unit: "ACTION", count: 1, owner: "BATTLE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUNA_HUNGRY_PS1", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUNA_HUNGRY_PS1",
    intent: "(不成立): 味方以外が攻撃されても発動しない",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUNA_HUNGRY_PS1",
      trigger: unitBeingAttacked({ source: "ally:front", target: "enemy:front" }),
      triggeredBy: "ally:front",
    },
    expected: {
      activated: false,
    },
  },
  {
    skillDefinitionId: "SKL_LUNA_HUNGRY_PS2",
    intent:
      "ターン開始時に発動。自身に対し、最大HP×40%のシールドを付与する。シールドは2行動後に消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUNA_HUNGRY_PS2",
      trigger: turnStarted({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS2_SHIELD", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS2_SHIELD",
          magnitude: 4000,
          timeLimit: { unit: "ACTION", count: 2, owner: "EFFECT_SOURCE" },
        },
      ],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
      cooldowns: [
        { unitId: "ally:subject", skillDefinitionId: "SKL_LUNA_HUNGRY_PS2", remaining: 1 },
      ],
    },
  },
  {
    skillDefinitionId: "SKL_LUNA_HUNGRY_PS3",
    intent:
      "ターン終了時に発動。自身に対し攻撃力×100%のシールドを付与し、自身を1行動の間「パワフル」状態にする。シールドは1行動後に消滅する",
    use: {
      kind: "PASSIVE",
      skillDefinitionId: "SKL_LUNA_HUNGRY_PS3",
      trigger: turnCompleting({ unit: "ally:subject", turnNumber: 1 }),
      triggeredBy: "ally:subject",
    },
    expected: {
      actions: [
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS3_SHIELD", targets: ["ally:subject"] },
        { effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS3_MARKER", targets: ["ally:subject"] },
      ],
      effectsApplied: [
        {
          unitId: "ally:subject",
          effectActionDefinitionId: "ACT_LUNA_HUNGRY_PS3_SHIELD",
          // 攻撃力1000 × 100%。
          magnitude: 1000,
          timeLimit: { unit: "ACTION", count: 1, owner: "EFFECT_SOURCE" },
        },
      ],
      markers: [{ unitId: "ally:subject", markerId: POWERFUL_MARKER_ID, stackCount: 1 }],
      resources: [
        { unitId: "ally:subject", resource: "PP", delta: -1 },
        { unitId: "ally:subject", resource: "EX_GAUGE", delta: 1 },
      ],
    },
  },
];

describe("production Catalog UNIT_LUNA_HUNGRY (【博識なハングリーガール】ルナ・メロウ)", () => {
  it.each(BEHAVIOURS)(
    "IT-UNIT-LUNA-HUNGRY-001: $skillDefinitionId — $intent",
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

  it("IT-UNIT-LUNA-HUNGRY-002: the table covers exactly the Skills the production UnitDefinition declares", () => {
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

  it("IT-UNIT-LUNA-HUNGRY-003: every EffectAction reachable from this unit was actually executed by the table above", () => {
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
